import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import {
  CONVERSATION_CLAIM_CHANGED,
  ConversationClaimChangedEvent,
} from '../messaging/conversation-claim';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  CONVERSATION_MEMBERSHIP_REVOKED,
  ConversationMembershipRevokedEvent,
} from '../messaging/messaging.events';
import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';
import {
  IDENTITY_STAFFING_CHANGED,
  IdentityStaffingChangedEvent,
} from './identity-staffing.events';

/** A page of the sweep's own paging, kept small so a scheduler tick stays
 * cheap and predictable regardless of how many business mailboxes exist. */
const DEFAULT_SWEEP_PAGE_SIZE = 200;

/** What one page of the sweep did, so a caller (a scheduler, an admin
 * button, a test) can decide whether to keep paging. */
export interface MailboxSweepPageResult {
  processedIdentityCount: number;
  lastIdentityId: string | null;
}

/** One thread a departing staff member's seat just ended in, reported by
 * `onStaffRemoved`/`resyncMailbox` so a caller can emit
 * `CONVERSATION_MEMBERSHIP_REVOKED` for it (immediately, or deferred to
 * after the caller's own transaction resolves; see `emitMembershipRevoked`
 * and the `shouldDeferEmission` option). */
export interface EndedMailboxSeat {
  conversationId: string;
  userId: string;
}

/**
 * Task 25: everything one `onStaffAdded`/`onStaffRemoved`/`resyncMailbox`
 * call changed that someone must hear about live. `endedSeats` feeds
 * `CONVERSATION_MEMBERSHIP_REVOKED`, `releasedClaims` are the system releases
 * of a departing claimant's claims (`CONVERSATION_CLAIM_CHANGED`), and
 * `staffingChanges` name each user whose staff standing this call started or
 * ended (`IDENTITY_STAFFING_CHANGED`). `emitSeatChanges` sends all three.
 */
export interface MailboxSeatChanges {
  endedSeats: EndedMailboxSeat[];
  releasedClaims: ConversationClaimChangedEvent[];
  staffingChanges: IdentityStaffingChangedEvent[];
}

/** What `seatAcrossMailbox` did for one user. */
interface MailboxSeating {
  hasChangedSeats: boolean;
  hasMailboxThreads: boolean;
}

/** What `unseatUser` did for one user. */
interface MailboxUnseating {
  endedSeats: EndedMailboxSeat[];
  releasedClaims: ConversationClaimChangedEvent[];
  hasMailboxThreads: boolean;
}

/**
 * Keeps mailbox seats in step with the staff list. The business side of a
 * thread is one participant row per staff member, which is what keeps unread,
 * mute, pin and drafts per person, so a staff change has to reach every thread
 * in that mailbox. A seat is a READ GRANT over every customer conversation the
 * mailbox holds, so a staff member who keeps a seat after they stop being
 * staff keeps reading private conversation they no longer have any standing
 * to see.
 *
 * A new arrival is seated with `clearedAt` set to now, so they start from the
 * present and do not inherit conversations that happened before they joined.
 * A departure marks `leftAt` and keeps the row, so message attribution
 * survives. Task 14a: that seat reads nothing of the mailbox while `leftAt`
 * stays set (`isStaffSeatExcludedFromMailbox`). A member who returns to a
 * mailbox they previously left is reactivated on their existing row, so the
 * seat stays one row per person. They resume with the SAME `clearedAt = now`
 * floor a brand-new hire gets (cleanup wave ruling: a rehired staff member is
 * just a staff member again). An earlier rule floored a rehire at the later
 * of their old `clearedAt` and the moment they left, which revealed
 * everything from their departure date forward; the current floor keeps that
 * window hidden, matching a new hire.
 *
 * `onStaffAdded` and `onStaffRemoved` are deltas: the caller already knows
 * which user changed. `resyncMailbox` needs no delta. It recomputes the
 * staff set from source via `IdentitiesService.staffUserIds`, compares it
 * against the seats currently attached to the identity, and applies exactly
 * the difference. It exists for callers that cannot supply a single changed
 * user id (a bulk seat revocation that only reports a count), and it is the
 * general safety net: the set of paths that can change who is effectively
 * staff is larger than the set any caller can enumerate, so a periodic sweep
 * that reconciles every non-profile identity from source closes whatever an
 * event hook missed.
 *
 * NO HOOK HANDLES DELETION, on purpose. A hard-deleted listing or subprofile
 * takes its `listing_co_managers` or `subprofile_members` rows, its own
 * `identities` row, and every `conversation_participants` seat on that
 * mailbox with it, all through `ON DELETE CASCADE` on the foreign keys
 * involved. There is no window where a staff row survives its listing or
 * persona, so there is nothing here for a delete path to call. A reader
 * adding one would be closing a gap that does not exist.
 *
 * All three entry points are idempotent and safe to re-run.
 */
@Injectable()
export class IdentityMailboxSyncService {
  private readonly logger = new Logger(IdentityMailboxSyncService.name);

  constructor(
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Identity)
    private readonly identities: Repository<Identity>,
    // Read by `unseatUser` to release a departing staff member's claims in
    // this same mailbox. See that method's doc for why this is where the
    // release belongs.
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly identitiesService: IdentitiesService,
    // Read by `unseatUser` to tell `ChatGateway` which live rooms a
    // departing staff member's sockets must leave.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Seat `userId` into every thread of `identityId`'s mailbox. Safe to call
   * for someone already seated (skipped) or returning from a past departure
   * (reactivated on their existing row). Pass `manager` to join a caller's
   * open transaction, so a failed sync rolls the staff change back with it.
   *
   * Task 25: reports `{ isStaff: true }` for `userId` when this call seated or
   * reactivated at least one seat, and when the mailbox has no threads yet
   * (the member still gained a mailbox, with nothing to seat them in). A
   * repeat call on a mailbox with threads changes nothing and reports
   * nothing. Same `shouldDeferEmission` contract as `onStaffRemoved`. */
  async onStaffAdded(
    identityId: string,
    userId: string,
    manager?: EntityManager,
    options?: { shouldDeferEmission?: boolean },
  ): Promise<MailboxSeatChanges> {
    const seating = await this.seatAcrossMailbox(
      this.participantsRepository(manager),
      identityId,
      userId,
    );
    const changes: MailboxSeatChanges = {
      endedSeats: [],
      releasedClaims: [],
      staffingChanges:
        seating.hasChangedSeats || !seating.hasMailboxThreads
          ? [{ identityId, userId, isStaff: true }]
          : [],
    };
    if (!options?.shouldDeferEmission) {
      this.emitSeatChanges(changes);
    }
    return changes;
  }

  /** End `userId`'s seat in every thread of `identityId`'s mailbox they are
   * currently active in. The rows are kept with `leftAt` stamped, never
   * deleted, so message attribution survives and a return reactivates the
   * same row. Pass `manager` to join a caller's open transaction.
   *
   * Returns the threads the seat ended in, and (unless `shouldDeferEmission` is
   * set) also emits `CONVERSATION_MEMBERSHIP_REVOKED` for each of them
   * immediately, which is safe whenever this call is not itself riding a
   * caller's still-open transaction. A caller that DOES own that
   * transaction (runs `dataSource.transaction(...)` itself and passes that
   * transaction's `manager` in here) should pass `shouldDeferEmission: true` and
   * call `emitMembershipRevoked` with the returned list only after its own
   * `transaction()` call resolves, mirroring `GroupsService.leaveGroup`'s
   * post-commit fan-out. Without that, a rolled-back transaction can still
   * have told a client's socket to leave a room it never actually lost
   * access to.
   *
   * Task 25: the returned changes also carry the system release of each claim
   * `userId` held in this mailbox, and `{ isStaff: false }` for `userId` when
   * this call ended at least one seat or the mailbox has no threads yet. The
   * deferred path sends all of it through `emitSeatChanges`. */
  async onStaffRemoved(
    identityId: string,
    userId: string,
    manager?: EntityManager,
    options?: { shouldDeferEmission?: boolean },
  ): Promise<MailboxSeatChanges> {
    const unseating = await this.unseatUser(
      this.participantsRepository(manager),
      this.conversationsRepository(manager),
      identityId,
      userId,
    );
    const changes: MailboxSeatChanges = {
      endedSeats: unseating.endedSeats,
      releasedClaims: unseating.releasedClaims,
      staffingChanges:
        unseating.endedSeats.length > 0 || !unseating.hasMailboxThreads
          ? [{ identityId, userId, isStaff: false }]
          : [],
    };
    if (!options?.shouldDeferEmission) {
      this.emitSeatChanges(changes);
    }
    return changes;
  }

  /**
   * Recompute `identityId`'s mailbox seats from source: read the current
   * staff set, compare it against who currently holds an active seat, seat
   * whoever is missing and end whoever is no longer staff. A no-op when the
   * two sets already agree, which is what makes this safe to call after every
   * ownership-adjacent write regardless of whether that particular write
   * happened to change anything.
   *
   * `staffUserIds` already returns the owner plus every active co-manager (or
   * the equivalent for a subprofile or company), so there is no separate
   * "ownerless mailbox" case to encode here: an ownerless-and-staffless
   * identity simply reconciles to zero seats, and one with active co-managers
   * keeps them.
   *
   * Pass `manager` so the read of both sides happens inside a caller's open
   * transaction and sees that transaction's own not-yet-committed writes.
   *
   * Returns every thread a departed user's seat ended in, across every
   * departed user this run found, and (unless `shouldDeferEmission` is set) also
   * emits `CONVERSATION_MEMBERSHIP_REVOKED` for each of them immediately.
   * Same `shouldDeferEmission` contract as `onStaffRemoved`: a caller that owns
   * the transaction `manager` came from must pass `shouldDeferEmission: true` and
   * emit the returned list itself once its own `transaction()` call
   * resolves.
   *
   * Task 25: reports `{ isStaff: true }` for each missing staff member this
   * run actually seated, and `{ isStaff: false }` for each departed user whose
   * seats it ended, with their released claims. A mailbox with no threads
   * seats nobody, so a resync of one reports no arrival: every staff member
   * would read as missing on every run, and the sweep would announce them
   * again on each tick.
   */
  async resyncMailbox(
    identityId: string,
    manager?: EntityManager,
    options?: { shouldDeferEmission?: boolean },
  ): Promise<MailboxSeatChanges> {
    const participantsRepository = this.participantsRepository(manager);
    const conversationsRepository = this.conversationsRepository(manager);
    const staffUserIds = new Set(
      await this.identitiesService.staffUserIds(identityId),
    );
    const activeSeats = await participantsRepository.find({
      where: { identityId, leftAt: IsNull() },
      select: { userId: true },
    });
    const seatedUserIds = new Set(activeSeats.map((seat) => seat.userId));

    const missingStaffUserIds = [...staffUserIds].filter(
      (userId) => !seatedUserIds.has(userId),
    );
    const departedUserIds = [...seatedUserIds].filter(
      (userId) => !staffUserIds.has(userId),
    );

    const changes: MailboxSeatChanges = {
      endedSeats: [],
      releasedClaims: [],
      staffingChanges: [],
    };
    for (const userId of missingStaffUserIds) {
      const seating = await this.seatAcrossMailbox(
        participantsRepository,
        identityId,
        userId,
      );
      if (seating.hasChangedSeats) {
        changes.staffingChanges.push({ identityId, userId, isStaff: true });
      }
    }
    for (const userId of departedUserIds) {
      const unseating = await this.unseatUser(
        participantsRepository,
        conversationsRepository,
        identityId,
        userId,
      );
      changes.endedSeats.push(...unseating.endedSeats);
      changes.releasedClaims.push(...unseating.releasedClaims);
      if (unseating.endedSeats.length > 0) {
        changes.staffingChanges.push({ identityId, userId, isStaff: false });
      }
    }
    if (!options?.shouldDeferEmission) {
      this.emitSeatChanges(changes);
    }
    return changes;
  }

  /**
   * Task 18 fix round 1: `resyncMailbox` for ONE thread of the mailbox, for a
   * customer's send into a thread that already exists, where reconciling the
   * whole mailbox would be too heavy. Compares this thread's own seats for
   * `identityId` against the current staff: a staff member with no seat here
   * is seated, a staff member whose seat here has `leftAt` is reactivated on
   * that row, both floored at `clearedAt = now` as `seatAcrossMailbox` floors
   * a new or returning hire. An active seat of someone no longer staff is
   * ended with `leftAt`, and a claim they hold on this thread is released,
   * the departure semantics of `unseatUser` confined to this thread. The
   * customer's seat carries another identity and is never changed.
   *
   * A FORMER CUSTOMER WHO IS NOW STAFF. There is one seat per
   * (conversation, user) (`UQ_conversation_participants`), so a staff member
   * who already sits in this thread under another identity, as its customer,
   * keeps that customer seat as their only seat here: in this thread they are
   * the customer. `seatAcrossMailbox` applies the same rule to the whole
   * mailbox.
   *
   * Same `manager` and `shouldDeferEmission` contract as `resyncMailbox`:
   * the ended seats and the system claim release are returned, and emitted
   * through `emitSeatChanges` immediately unless deferred. The release goes
   * out as the same `CONVERSATION_CLAIM_CHANGED` event `unseatUser` reports,
   * so colleagues stop reading the departed member as the claimant. No
   * staffing change is reported: seating or unseating people on one thread
   * leaves their standing in the mailbox as it was.
   */
  async resyncConversation(
    identityId: string,
    conversationId: string,
    manager?: EntityManager,
    options?: { shouldDeferEmission?: boolean },
  ): Promise<MailboxSeatChanges> {
    const participantsRepository = this.participantsRepository(manager);
    const conversationsRepository = this.conversationsRepository(manager);
    const staffUserIds = new Set(
      await this.identitiesService.staffUserIds(identityId),
    );
    // Every seat in the thread, whatever its identity, so a staff member who
    // is this thread's customer is recognised by their customer seat.
    const threadSeats = await participantsRepository.find({
      where: { conversationId },
      select: { userId: true, identityId: true, leftAt: true },
    });
    const seats = threadSeats.filter((seat) => seat.identityId === identityId);
    const seatByUserId = new Map(
      threadSeats.map((seat) => [seat.userId, seat]),
    );
    const now = new Date();

    const rowsToCreate: ConversationParticipant[] = [];
    for (const staffUserId of staffUserIds) {
      const seat = seatByUserId.get(staffUserId);
      if (seat && seat.identityId !== identityId) {
        // Their customer seat in this thread stays as it is.
        continue;
      }
      if (!seat) {
        rowsToCreate.push(
          participantsRepository.create({
            conversationId,
            userId: staffUserId,
            identityId,
            clearedAt: now,
          }),
        );
      } else if (seat.leftAt) {
        await participantsRepository.update(
          { identityId, userId: staffUserId, conversationId },
          { leftAt: null, clearedAt: now },
        );
      }
    }
    if (rowsToCreate.length > 0) {
      await participantsRepository.save(rowsToCreate);
    }

    const departedUserIds = seats
      .filter((seat) => !seat.leftAt && !staffUserIds.has(seat.userId))
      .map((seat) => seat.userId);
    const changes: MailboxSeatChanges = {
      endedSeats: [],
      releasedClaims: [],
      staffingChanges: [],
    };
    for (const departedUserId of departedUserIds) {
      await participantsRepository.update(
        {
          identityId,
          userId: departedUserId,
          conversationId,
          leftAt: IsNull(),
        },
        { leftAt: now },
      );
      // Recorded as a system release: no releasing person, a release time,
      // and no take-over, so the row never reads "unclaimed but taken over".
      const released = await conversationsRepository.update(
        { id: conversationId, claimedByUserId: departedUserId },
        {
          claimedByUserId: null,
          claimedAt: null,
          claimReleasedByUserId: null,
          claimReleasedAt: now,
          claimTakenOverFromUserId: null,
        },
      );
      if (released.affected) {
        this.logger.log(
          `System released the claim on ${conversationId} in mailbox ` +
            `${identityId} because ${departedUserId} stopped being staff there`,
        );
        changes.releasedClaims.push({
          conversationId,
          mailboxIdentityId: identityId,
          change: 'released',
          isImplicit: false,
          actorUserId: null,
          claimedByUserId: null,
          previousClaimantUserId: departedUserId,
          changedAt: now,
        });
      }
      changes.endedSeats.push({ conversationId, userId: departedUserId });
    }
    if (!options?.shouldDeferEmission) {
      this.emitSeatChanges(changes);
    }
    return changes;
  }

  /**
   * The general safety net: one page of every non-profile identity
   * (`listing`, `subprofile`, `company`), each reconciled against source.
   * Plain and pageable on purpose, so a scheduler can call it on a timer
   * without this method needing to change shape: pass the previous call's
   * `lastIdentityId` back in as `afterIdentityId` to continue, and a `null`
   * `lastIdentityId` on the result means the sweep reached the end.
   *
   * A profile identity is excluded: its one seat is the member themselves,
   * fixed for the life of the account, and reconciling it would be work spent
   * on something that can never drift.
   */
  async resyncNonProfileIdentitiesPage(
    afterIdentityId: string | null = null,
    pageSize: number = DEFAULT_SWEEP_PAGE_SIZE,
  ): Promise<MailboxSweepPageResult> {
    const page = await this.identities.find({
      where: {
        kind: Not(IdentityKind.Profile),
        ...(afterIdentityId ? { id: MoreThan(afterIdentityId) } : {}),
      },
      order: { id: 'ASC' },
      take: pageSize,
    });
    for (const identity of page) {
      await this.resyncMailbox(identity.id);
    }
    const lastIdentity = page.length > 0 ? page[page.length - 1] : undefined;
    return {
      processedIdentityCount: page.length,
      lastIdentityId: lastIdentity ? lastIdentity.id : null,
    };
  }

  /**
   * Fires `CONVERSATION_MEMBERSHIP_REVOKED` for every ended seat
   * `onStaffRemoved`/`resyncMailbox` reported, one event per conversation,
   * exactly the shape those two methods used to emit synchronously
   * themselves. Public so a caller that passed `shouldDeferEmission: true` (because
   * it owns the transaction the seat ending rode in) can call this once its
   * own `dataSource.transaction(...)` call has resolved, mirroring
   * `GroupsService.leaveGroup`'s post-commit fan-out: the event only goes
   * out once the seat ending is certain to have committed, so a client's
   * socket is never told to leave a room over a write that then rolled back.
   */
  emitMembershipRevoked(endedSeats: EndedMailboxSeat[]): void {
    for (const { conversationId, userId } of endedSeats) {
      this.emitBestEffort(CONVERSATION_MEMBERSHIP_REVOKED, {
        conversationId,
        userIds: [userId],
      } satisfies ConversationMembershipRevokedEvent);
    }
  }

  /** Task 25: fires `CONVERSATION_CLAIM_CHANGED` for each system release a
   * seat-ending call reported, on the same post-commit schedule as
   * `emitMembershipRevoked`, so colleagues stop reading a departed member as
   * the claimant. */
  emitClaimsReleased(releasedClaims: ConversationClaimChangedEvent[]): void {
    for (const releasedClaim of releasedClaims) {
      this.emitBestEffort(CONVERSATION_CLAIM_CHANGED, releasedClaim);
    }
  }

  /** Task 25: fires `IDENTITY_STAFFING_CHANGED` for each staffing change a
   * seat call reported, on the same post-commit schedule as
   * `emitMembershipRevoked`. */
  emitStaffingChanged(staffingChanges: IdentityStaffingChangedEvent[]): void {
    for (const staffingChange of staffingChanges) {
      this.emitBestEffort(IDENTITY_STAFFING_CHANGED, staffingChange);
    }
  }

  /** Task 25: sends everything one seat call reported, in order: the room
   * evictions first, then the claim releases, then the staffing changes. A
   * caller that deferred emission calls this once its own transaction has
   * resolved. */
  emitSeatChanges(changes: MailboxSeatChanges): void {
    this.emitMembershipRevoked(changes.endedSeats);
    this.emitClaimsReleased(changes.releasedClaims);
    this.emitStaffingChanged(changes.staffingChanges);
  }

  /** A live-room instruction never fails the seat write it follows. */
  private emitBestEffort(eventName: string, payload: unknown): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch (error) {
      this.logger.error(
        `Failed to emit ${eventName}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private participantsRepository(
    manager?: EntityManager,
  ): Repository<ConversationParticipant> {
    return manager
      ? manager.getRepository(ConversationParticipant)
      : this.participants;
  }

  private conversationsRepository(
    manager?: EntityManager,
  ): Repository<Conversation> {
    return manager ? manager.getRepository(Conversation) : this.conversations;
  }

  /**
   * Seat `userId` into every conversation of `identityId`'s mailbox they are
   * not already active in. A conversation with no row for them yet gets a
   * fresh one, floored at `clearedAt = now` so they do not inherit history
   * from before they joined. A conversation where they hold a row with
   * `leftAt` set (they were seated before and left, whether by removal or by
   * a prior sync) is reactivated on that same row: `leftAt` is cleared and
   * `clearedAt` is floored at `now`, same as a brand-new hire. A rehired
   * staff member is just a staff member again, so they get the same history
   * floor a newly added staff member gets. A conversation where they already
   * hold an active row is left untouched.
   *
   * A FORMER CUSTOMER WHO IS NOW STAFF. A member who once wrote to this
   * mailbox holds a customer seat in that thread under their own identity,
   * and there is one seat per (conversation, user)
   * (`UQ_conversation_participants`). That thread keeps the customer seat
   * as their only seat there: in their own conversation with the business
   * they stay the customer. They are staffed in every other
   * thread of the mailbox. This mirrors the enquiry migration's
   * `customer_is_staff` skip, and `unseatUser` never touches the customer
   * seat because it only reads seats carrying this mailbox's identity.
   *
   * Reports whether any seat was created or reactivated, and whether the
   * mailbox has any thread this user can be staff in. A mailbox whose only
   * threads are the user's own customer threads counts as having none, so
   * `onStaffAdded` still reports the new staff standing.
   */
  private async seatAcrossMailbox(
    participantsRepository: Repository<ConversationParticipant>,
    identityId: string,
    userId: string,
  ): Promise<MailboxSeating> {
    const mailboxSeats = await participantsRepository.find({
      where: { identityId },
      select: { conversationId: true },
    });
    const conversationIds = [
      ...new Set(mailboxSeats.map((seat) => seat.conversationId)),
    ];
    if (conversationIds.length === 0) {
      return { hasChangedSeats: false, hasMailboxThreads: false };
    }

    // Every seat the user holds in these threads, whatever its identity, so a
    // customer seat is recognised and left alone.
    const existingSeats = await participantsRepository.find({
      where: { userId, conversationId: In(conversationIds) },
      select: { conversationId: true, identityId: true, leftAt: true },
    });
    const existingSeatByConversationId = new Map(
      existingSeats.map((seat) => [seat.conversationId, seat]),
    );
    const isCustomerSeatThread = (conversationId: string): boolean => {
      const existingSeat = existingSeatByConversationId.get(conversationId);
      return (
        existingSeat !== undefined && existingSeat.identityId !== identityId
      );
    };
    const staffableConversationIds = conversationIds.filter(
      (conversationId) => !isCustomerSeatThread(conversationId),
    );
    if (staffableConversationIds.length === 0) {
      return { hasChangedSeats: false, hasMailboxThreads: false };
    }

    const now = new Date();
    const rowsToCreate: ConversationParticipant[] = [];
    let hasReactivatedSeat = false;

    for (const conversationId of staffableConversationIds) {
      const existingSeat = existingSeatByConversationId.get(conversationId);
      if (!existingSeat) {
        rowsToCreate.push(
          participantsRepository.create({
            conversationId,
            userId,
            identityId,
            clearedAt: now,
          }),
        );
        continue;
      }
      if (!existingSeat.leftAt) {
        // Already active here; nothing to do.
        continue;
      }
      // Rehire floor matches the new-hire floor: `now`. An earlier rule
      // floored this at the later of the old `clearedAt`/`leftAt`, which
      // revealed everything from their departure date forward, including
      // history the thread itself now hides from a returning member.
      await participantsRepository.update(
        { identityId, userId, conversationId },
        { leftAt: null, clearedAt: now },
      );
      hasReactivatedSeat = true;
    }

    if (rowsToCreate.length > 0) {
      await participantsRepository.save(rowsToCreate);
    }
    return {
      hasChangedSeats: hasReactivatedSeat || rowsToCreate.length > 0,
      hasMailboxThreads: true,
    };
  }

  /**
   * End `userId`'s active seats in `identityId`'s mailbox, across every
   * conversation at once, and release any claim they hold in that same
   * mailbox. A seat already ended (`leftAt` set) is untouched, which is
   * what makes a repeat call a no-op.
   *
   * THE CLAIM RELEASE. `PushMessageListener.eligibleMessagePushRecipientUserIds`
   * narrows the STAFF side of a claimed thread's push to the claimant (Task
   * 12, corrected by Task 13d); the customer is always in the audience. A
   * claimant whose own seat has just ended holds no live seat, so an
   * unreleased claim would leave the customer's messages pushing to no staff
   * member, indefinitely, with no signal to a colleague that the thread
   * needs attention. Clearing `claimedByUserId`/`claimedAt` here, in the
   * same write as the seat ending, reverts the thread to unclaimed and
   * routes it through the ordinary unclaimed-thread push path to the
   * remaining staff. This is what keeps the push listener free of a
   * departed-claimant branch of its own.
   *
   * SCOPED TO THIS MAILBOX. The conversations eligible for release are
   * exactly the ones this identity has a seat in, the same set
   * `seatAcrossMailbox` computes. A person who is staff of two mailboxes
   * and leaves one keeps every claim they hold in the other, because this
   * method only ever reads seats carrying THIS `identityId`.
   *
   * RECORDED (Task 25). The same UPDATE records a system release: no
   * releasing person (`claimReleasedByUserId` null), `claimReleasedAt` set to
   * the seat-ending instant, and `claimTakenOverFromUserId` cleared, so the
   * row never reads as unclaimed yet taken over from someone. Staff reads
   * then show "released" with no person. Each released thread comes back as
   * a `CONVERSATION_CLAIM_CHANGED` event with a null actor, sent on the same
   * schedule as the room eviction, so colleagues stop reading the departed
   * member as the claimant.
   *
   * EVICTED (Task 14a). A departed staff seat has no access to the mailbox
   * (`isStaffSeatExcludedFromMailbox` in `mailbox-seats.ts`), and every live
   * frame after a socket's join is a room emit, so each thread whose seat
   * this call ends is reported back to the caller (`onStaffRemoved`/
   * `resyncMailbox`) as an ended seat, one `CONVERSATION_MEMBERSHIP_REVOKED`
   * per thread, the event `ChatGateway` already answers for a member removed
   * from a group by making that user's sockets leave that one room. Their
   * other rooms, notifications and presence are untouched. This method
   * itself never emits: the event goes out only through
   * `emitMembershipRevoked`, called by the caller either immediately (the
   * default) or, when a caller owns the transaction `manager` came from,
   * after that transaction resolves; see `onStaffRemoved`'s doc.
   */
  private async unseatUser(
    participantsRepository: Repository<ConversationParticipant>,
    conversationsRepository: Repository<Conversation>,
    identityId: string,
    userId: string,
  ): Promise<MailboxUnseating> {
    const now = new Date();
    const endingSeats = await participantsRepository.find({
      where: { identityId, userId, leftAt: IsNull() },
      select: { conversationId: true },
    });
    await participantsRepository.update(
      { identityId, userId, leftAt: IsNull() },
      { leftAt: now },
    );
    const endedSeats: EndedMailboxSeat[] = [
      ...new Set(endingSeats.map((seat) => seat.conversationId)),
    ].map((conversationId) => ({ conversationId, userId }));

    const mailboxSeats = await participantsRepository.find({
      where: { identityId },
      select: { conversationId: true },
    });
    const mailboxConversationIds = [
      ...new Set(mailboxSeats.map((seat) => seat.conversationId)),
    ];
    if (mailboxConversationIds.length === 0) {
      return { endedSeats, releasedClaims: [], hasMailboxThreads: false };
    }
    const released = await conversationsRepository
      .createQueryBuilder()
      .update()
      .set({
        claimedByUserId: null,
        claimedAt: null,
        claimReleasedByUserId: null,
        claimReleasedAt: now,
        claimTakenOverFromUserId: null,
      })
      .where('id IN (:...mailboxConversationIds)', { mailboxConversationIds })
      .andWhere('claimed_by_user_id = :userId', { userId })
      .returning(['id'])
      .execute();
    const releasedConversationIds = releasedIds(released.raw);
    if (releasedConversationIds.length > 0) {
      this.logger.log(
        `System released ${releasedConversationIds.length} claim(s) in ` +
          `mailbox ${identityId} because ${userId} stopped being staff there`,
      );
    }
    const releasedClaims = releasedConversationIds.map(
      (conversationId): ConversationClaimChangedEvent => ({
        conversationId,
        mailboxIdentityId: identityId,
        change: 'released',
        isImplicit: false,
        actorUserId: null,
        claimedByUserId: null,
        previousClaimantUserId: userId,
        changedAt: now,
      }),
    );
    return { endedSeats, releasedClaims, hasMailboxThreads: true };
  }
}

/** The `id` of each row an UPDATE ... RETURNING id reported. */
function releasedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((row: unknown) =>
      row && typeof row === 'object'
        ? (row as Record<string, unknown>).id
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string');
}
