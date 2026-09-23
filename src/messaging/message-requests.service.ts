import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  CONNECTION_ACCEPTED,
  ConnectionAcceptedEvent,
} from '../connections/connection.events';
import { ConnectionsService } from '../connections/connections.service';
import { IdentityMailboxSyncService } from '../identities/identity-mailbox-sync.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { sanitizeMessageBody } from './dto/trim-message-body';
import { MessageView } from './message-response';
import {
  IdentityContactRefusal,
  identityContactRefusalException,
  MessagingCoreService,
} from './messaging-core.service';

/** Why a cold enquiry cannot be delivered. `self` is a caller bug (enquiring on
 *  your own thing); `blocked` is a block in either direction, the one hard stop
 *  `deliverEnquiry` keeps. */
export type EnquiryBlockedReason = 'self' | 'blocked';

/** Answer to "may this member cold-contact that one, and what will the thread
 *  then allow?" See `MessageRequestsService.enquiryContactability`. */
export interface EnquiryContactability {
  canDeliver: boolean;
  blockedReason: EnquiryBlockedReason | null;
  /**
   * Always `false` while `canDeliver` is true (PRD-340): the enquiry recipient
   * may always post their first ordinary reply without a connection. That
   * reply is what opens the thread for both sides. Kept (rather than removed)
   * so callers built against this contract don't need a second lookup. A
   * caller that still wants to warn the ENQUIRER should read this as "always
   * fine to answer", never as "will refuse", and should prefer
   * `followUpAwaitsReply` below for the honest, PRD-340-aware copy.
   */
  replyRequiresConnection: boolean;
  /**
   * PRD-340: true when the two are NOT accepted connections, so the
   * RECIPIENT's reply opens the thread rather than it already being open.
   * This is what a pre-send notice to the ENQUIRER should actually say:
   * the recipient can answer straight away (no connection needed for
   * THEIR first reply), and the enquirer can send more once they do. Always
   * `false` when the pair is already connected (an ordinary open thread,
   * nothing to explain) and whenever `canDeliver` is `false` (nothing will
   * be delivered to explain).
   */
  followUpAwaitsReply: boolean;
}

/**
 * Task 18: why a cold enquiry cannot reach a mailbox identity. `blocked` is
 * the member's own block of that business, persona or company, or (fix round
 * 1) a mailbox whose every staff member is person-blocked with the member,
 * either way, so that nobody could read the message. The two read the same
 * on purpose. Every other value is the `IdentityContactRefusal` the write
 * would throw.
 */
export type IdentityEnquiryBlockedReason = 'blocked' | IdentityContactRefusal;

/** Task 18 fix round 1: the stable code of the `blocked` refusal. */
export const IDENTITY_BLOCKED_CODE = 'IDENTITY_BLOCKED';

/**
 * Task 18 fix round 1: the 403 for a `blocked` enquiry, the one body every
 * enquiry entry point (directory, persona, company) and the delivery itself
 * throw, so a client keys off `code` and the sentence reads the same
 * whichever of the two causes it was.
 */
export function identityBlockedException(): ForbiddenException {
  return new ForbiddenException({
    code: IDENTITY_BLOCKED_CODE,
    message: 'You cannot contact this business',
  });
}

/**
 * The staff members among `staffUserIds` whose account can receive a message
 * right now: an active account that is not a system account. A system
 * account is the house account seeded content is parked on, with no human
 * reading its inbox. A suspended or deactivated member is signed out
 * everywhere and has no push subscription left (`AuthService.revokeAllForUser`,
 * `PushService.handleSessionRevoked`), so a message only they could read
 * would sit unread.
 *
 * The one home of this rule. `MessageRequestsService` applies it, with
 * blocks, to decide whether a mailbox enquiry can reach anybody, and
 * `ListingEnquiriesService` applies it on its own to tell a listing nobody
 * can answer apart from one the member is blocked from. One read for the
 * whole list, which is an owner plus a handful of colleagues.
 */
export async function loadReceivingStaffUserIds(
  users: Pick<Repository<User>, 'find'>,
  staffUserIds: string[],
): Promise<string[]> {
  if (staffUserIds.length === 0) {
    return [];
  }
  const staffUsers = await users.find({
    where: { id: In(staffUserIds) },
    select: { id: true, isSystem: true, status: true },
  });
  const receivingUserIds = new Set(
    staffUsers
      .filter(
        (staffUser) =>
          !staffUser.isSystem && staffUser.status === UserStatus.Active,
      )
      .map((staffUser) => staffUser.id),
  );
  return staffUserIds.filter((staffUserId) =>
    receivingUserIds.has(staffUserId),
  );
}

/**
 * Task 18: the mailbox twin of `EnquiryContactability`, from
 * `MessageRequestsService.identityEnquiryContactability`.
 */
export interface IdentityEnquiryContactability {
  canDeliver: boolean;
  blockedReason: IdentityEnquiryBlockedReason | null;
  /** Always false: a staff member may always answer a cold enquiry, and
   *  that answer is what opens the thread. Kept so callers built against
   *  `EnquiryContactability` read the same field. */
  replyRequiresConnection: boolean;
  /**
   * True until the business has answered: personal connections do not apply
   * to a mailbox thread, so the member's follow-ups wait on the first reply
   * however the two humans are connected. False once the existing thread is
   * open, and whenever `canDeliver` is false.
   */
  followUpAwaitsReply: boolean;
  /** The thread the member already has with this mailbox, or null. */
  existingConversationId: string | null;
}

/**
 * Message-requests concern of the split `MessagingService`: cold-contact flows
 * that seed or bypass a 1:1 conversation without the caller already being a
 * participant — the "message a stranger" connection-request flow
 * (`messageRequest`), cross-domain enquiry delivery (`deliverEnquiry`, used by
 * housing/listings), and materializing the DM once a connection request is
 * accepted. Everyday thread reads/sends live in `MessagesService`/
 * `ConversationsService`.
 */
@Injectable()
export class MessageRequestsService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly core: MessagingCoreService,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
    // Task 18: seats the mailbox's current staff on a reused enquiry thread.
    private readonly mailboxSync: IdentityMailboxSyncService,
    // Read-only: whose account can receive an enquiry right now
    // (`loadReceivingStaffUserIds`). `UsersModule` exports the repository.
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async messageRequest(
    userId: string,
    toSlug: string,
    body: string,
  ): Promise<{
    conversationId: string | null;
    message: MessageView | null;
    connectionRequestId: string | null;
  }> {
    const recipient = await this.profiles.findOne({ where: { slug: toSlug } });
    if (!recipient) {
      throw new NotFoundException('Member not found');
    }
    if (recipient.userId === userId) {
      throw new BadRequestException('You cannot message yourself');
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, recipient.userId)) {
      throw new ForbiddenException('You cannot message this member');
    }

    if (await this.connectionsService.areConnected(userId, recipient.userId)) {
      const { conversation } = await this.core.getOrCreateConversation(
        userId,
        recipient.userId,
      );
      const { view } = await this.core.postMessage(
        conversation.id,
        userId,
        body,
      );
      return {
        conversationId: conversation.id,
        message: view,
        connectionRequestId: null,
      };
    }

    // Not connected: the message becomes the seed of a connection request (§7).
    const conn = await this.connectionsService.requestConnection(
      userId,
      toSlug,
      body,
    );
    return {
      conversationId: null,
      message: null,
      connectionRequestId: conn.id,
    };
  }

  /**
   * Can `fromUserId` deliver a cold enquiry to `toUserId` right now, and what
   * happens next in that thread?
   *
   * The read-only twin of `deliverEnquiry` below, for surfaces that have to
   * decide whether to OFFER a "message them" affordance at all rather than
   * discover the answer by throwing at the member after they have typed a
   * paragraph. It asks messaging the question instead of re-deriving the rules
   * in another domain, so there is still exactly one place that decides who may
   * cold-contact whom.
   *
   * `replyRequiresConnection`/`followUpAwaitsReply` are the parts callers
   * most need and the part that is easiest to get wrong. PRD-340:
   * `deliverEnquiry` seeds an explicit `initiatorUserId` on the thread it
   * creates/reuses, and `MessagesService.sendMessage`'s connection-gate block
   * lets the RECIPIENT (the one this method is asked about replying to) post
   * their first ordinary reply without a connection. That reply is what
   * opens the thread for both sides from then on. So the recipient never
   * needs a connection to reply to a cold enquiry, and
   * `replyRequiresConnection` is always false while `canDeliver` is true.
   * `followUpAwaitsReply` names the fact truthfully for a pre-send notice: it
   * is true exactly when the pair is not yet connected, so the enquirer
   * learns their thread stays a one-message enquiry until the recipient
   * replies, not that the recipient needs to connect first.
   */
  async enquiryContactability(
    fromUserId: string,
    toUserId: string,
  ): Promise<EnquiryContactability> {
    if (fromUserId === toUserId) {
      return {
        canDeliver: false,
        blockedReason: 'self',
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      };
    }
    if (await this.blockFilter.isBlockedEitherWay(fromUserId, toUserId)) {
      return {
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      };
    }
    const areConnected = await this.connectionsService.areConnected(
      fromUserId,
      toUserId,
    );
    return {
      canDeliver: true,
      blockedReason: null,
      replyRequiresConnection: false,
      followUpAwaitsReply: !areConnected,
    };
  }

  /**
   * Delivers a one-off message from `fromUserId` to `toUserId`, addressed by
   * userId (not slug), creating the 1:1 conversation if needed. Unlike
   * `sendMessage`/`messageRequest`, this intentionally does NOT require the two
   * to be accepted connections. It backs cold cross-domain contact such as a
   * housing enquiry, where a pre-existing friendship must not be a
   * precondition. A block either way is still a hard stop.
   *
   * PRD-340: this is THE one deliberately connection-bypassing delivery path,
   * so it is the ONLY caller that ever passes `coldContactInitiatorUserId` to
   * `getOrCreateConversation`, claiming (or seeding) `initiatorUserId` so the
   * recipient can answer with one tap. A second enquiry into an existing
   * un-replied thread claims it too, for the same reason a first one would.
   */
  async deliverEnquiry(
    fromUserId: string,
    toUserId: string,
    body: string,
  ): Promise<{ conversationId: string }> {
    if (fromUserId === toUserId) {
      throw new BadRequestException('You cannot send an enquiry to yourself');
    }
    if (await this.blockFilter.isBlockedEitherWay(fromUserId, toUserId)) {
      throw new ForbiddenException('You cannot contact this member');
    }
    // PRD-365: an enquiry skips the daily and open-pending request caps (each
    // enquiry domain keeps its own quota) but still meets the report-driven
    // pause. Contact between accepted connections is never paused.
    //
    // PRD-366: "who can message me" is deliberately NOT consulted here. An
    // enquiry is about something the recipient published in order to be
    // contacted (their own listing, room, job, trade), so even a member set
    // to 'connections' keeps receiving enquiries about it.
    if (!(await this.connectionsService.areConnected(fromUserId, toUserId))) {
      await this.connectionsService.assertRequestsNotPaused(fromUserId);
    }
    const { conversation } = await this.core.getOrCreateConversation(
      fromUserId,
      toUserId,
      fromUserId,
    );
    await this.core.postMessage(conversation.id, fromUserId, body);
    return { conversationId: conversation.id };
  }

  /**
   * Task 18: can `fromUserId` deliver a cold enquiry to the mailbox
   * `toIdentityId` (a listing, persona or company) right now, and what will
   * the thread allow afterwards? The read-only twin of
   * `deliverEnquiryToIdentity`, answering from the same two rules it
   * enforces: the member's own block of that identity, and
   * `MessagingCoreService.evaluateIdentityContact`. Nothing here names or
   * implies any staff member.
   */
  async identityEnquiryContactability(
    fromUserId: string,
    toIdentityId: string,
  ): Promise<IdentityEnquiryContactability> {
    const blockedReason = await this.identityEnquiryBlockedReason(
      fromUserId,
      toIdentityId,
    );
    if (blockedReason) {
      return {
        canDeliver: false,
        blockedReason,
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
        existingConversationId: null,
      };
    }
    const existing = await this.core.findIdentityConversation(
      fromUserId,
      toIdentityId,
    );
    return {
      canDeliver: true,
      blockedReason: null,
      replyRequiresConnection: false,
      followUpAwaitsReply: !existing?.openedAt,
      existingConversationId: existing?.id ?? null,
    };
  }

  /**
   * Task 18: `deliverEnquiry` for a mailbox. Delivers a one-off message from
   * `fromUserId` to the business, persona or company `toIdentityId`, in the
   * thread keyed on the pair of identities, seating every current staff
   * member. Every step of the personal path happens here too, with the
   * audience the mailbox gives it:
   *
   *  - the member's block of the identity is a hard stop, a 403 coded
   *    `IDENTITY_BLOCKED` (`identityBlockedException`);
   *  - the report-driven pause applies. Personal connection never reaches a
   *    mailbox thread, so it applies whoever the staff are;
   *  - `initiatorUserId` is seeded or claimed as the member, so any staff
   *    member can answer with one tap and that answer opens the thread;
   *  - a mailbox whose every staff member is person-blocked with the
   *    member, either way, refuses as the identity block does (fix round 1):
   *    the message could reach nobody;
   *  - a reused thread gets the current staff seated
   *    (`IdentityMailboxSyncService.resyncConversation`, this thread only,
   *    under the staff source lock in its own transaction), departed staff
   *    staying departed;
   *  - the message goes through `MessagingCoreService.postMessage`, whose
   *    `MESSAGE_CREATED` drives the live frames and the push, both built
   *    from the reachable mailbox seats.
   *
   * `asIdentityId` is the identity the member is acting as, when the request
   * names one. Only their own profile may open or reuse a thread
   * (`MessagingCoreService.assertInitiatorIsProfile`, `IDENTITY_CANNOT_INITIATE`).
   */
  async deliverEnquiryToIdentity(
    fromUserId: string,
    toIdentityId: string,
    body: string,
    asIdentityId?: string,
  ): Promise<{ conversationId: string }> {
    const blockedReason = await this.identityEnquiryBlockedReason(
      fromUserId,
      toIdentityId,
    );
    if (blockedReason === 'blocked') {
      throw identityBlockedException();
    }
    if (blockedReason) {
      throw identityContactRefusalException(blockedReason);
    }
    await this.connectionsService.assertRequestsNotPaused(fromUserId);
    const { conversation, created } =
      await this.core.getOrCreateIdentityConversation(
        fromUserId,
        toIdentityId,
        fromUserId,
        asIdentityId,
      );
    if (!created) {
      // Fix round 1: this one thread only. Reconciling the whole mailbox
      // during a customer's send was too heavy. Final review C, I1: under
      // the staff source lock, in a transaction of its own that the resync
      // opens, with the live events sent once it commits, so a revoke or
      // leave committing mid-resync is never undone on this thread.
      await this.mailboxSync.resyncConversation(
        toIdentityId,
        conversation.id,
        undefined,
        { shouldLockStaffSource: true },
      );
    }
    await this.core.postMessage(conversation.id, fromUserId, body);
    return { conversationId: conversation.id };
  }

  /**
   * Task 18 fix round 1: the one answer the contactability read and the
   * delivery share, for listings, personas and companies alike. `blocked`
   * for the member's block of the identity, and for a mailbox with no
   * reachable staff member. A reachable staff member is one who is neither
   * blocked with the member in either direction (the same read
   * `loadReachableMailboxSeats` excludes a seat on) nor behind an account
   * that cannot receive (`loadReceivingStaffUserIds`). Both halves hold for
   * the SAME person, so a suspended colleague who is not blocked and an
   * active one who is blocked leave nobody to read the message, and the
   * enquiry is refused. A person block with SOME staff still delivers while
   * another reachable colleague remains; the blocked seats are left out at
   * read time. Otherwise the coded `IdentityContactRefusal`, or null.
   */
  private async identityEnquiryBlockedReason(
    fromUserId: string,
    toIdentityId: string,
  ): Promise<IdentityEnquiryBlockedReason | null> {
    const [isIdentityBlocked, contact] = await Promise.all([
      this.blockFilter.isIdentityBlocked(fromUserId, toIdentityId),
      this.core.evaluateIdentityContact(fromUserId, toIdentityId),
    ]);
    if (isIdentityBlocked) {
      return 'blocked';
    }
    if (contact.refusal) {
      return contact.refusal;
    }
    const blockedStaffUserIds = await this.blockFilter.blockedUserIds(
      fromUserId,
      contact.staffUserIds,
    );
    const unblockedStaffUserIds = contact.staffUserIds.filter(
      (staffUserId) => !blockedStaffUserIds.has(staffUserId),
    );
    const reachableStaffUserIds = await loadReceivingStaffUserIds(
      this.users,
      unblockedStaffUserIds,
    );
    return reachableStaffUserIds.length > 0 ? null : 'blocked';
  }

  @OnEvent(CONNECTION_ACCEPTED)
  async handleConnectionAccepted(
    payload: ConnectionAcceptedEvent,
  ): Promise<void> {
    const { conversation, created } = await this.core.getOrCreateConversation(
      payload.requesterId,
      payload.addresseeId,
    );
    // Seed the request message only on first materialization (idempotent if the
    // event ever re-fires). A note that sanitizes to nothing seeds no bubble.
    if (
      created &&
      payload.requestMessage &&
      sanitizeMessageBody(payload.requestMessage)
    ) {
      await this.core.postMessage(
        conversation.id,
        payload.requesterId,
        payload.requestMessage,
      );
    }
    // PRD-340: reply-implies-accept. `ConnectionsService.respondWithReply`
    // attaches the addressee's own reply to THIS SAME event, so it is posted
    // right after the intro message it may have just seeded above, in this
    // one sequential `await` chain, with no second write path that could race
    // it and land the reply before the request it is answering. Absent for
    // every plain `respond('accept', ...)`, so this is a no-op for the
    // ordinary Accept button.
    if (payload.replyBody) {
      await this.core.postMessage(
        conversation.id,
        payload.addresseeId,
        payload.replyBody,
      );
    }
  }
}
