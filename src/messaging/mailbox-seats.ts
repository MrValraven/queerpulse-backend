import { IdentityKind } from '../identities/entities/identity.entity';
import type { IdentityDescription } from '../identities/identities.service';
import type { BlockFilterService } from '../social/block-filter.service';
import type { Profile } from '../users/entities/profile.entity';
import { buildAuthorSummary } from './author-summary';
import type { ConversationParticipant } from './entities/conversation-participant.entity';
import {
  AuthorSummary,
  FORMER_IDENTITY_AUTHOR,
  toAuthorSummary,
} from './message-response';

/**
 * Task 13c: which identity every seat of one DIRECT, non-official thread
 * speaks for, read from one caller's side. Messaging code written before
 * business mailboxes read "the other participant" as one human's row. A
 * mailbox thread seats one row per staff member, all carrying the mailbox
 * identity, beside the customer's own profile-identity row, so "the other
 * participant" is a customer for a staff caller and a business for a
 * customer. Every read and enforcement path that needs a counterpart asks
 * this one function, so the inbox, the send-time gate and the live-room gate
 * all agree on which seat that is.
 */
export interface DirectThreadSeats {
  /** The caller's own seat carries a business/persona/company identity. */
  readonly isCallerMailboxSeat: boolean;
  /**
   * The shared mailbox identity this thread belongs to: the caller's own
   * identity for a staff caller, the one distinct mailbox identity among the
   * other seats for a customer, and `undefined` for an ordinary member
   * thread.
   */
  readonly mailboxIdentityId: string | undefined;
  /**
   * Task 14: every distinct business, persona or company identity among the
   * other seats, in the order first met, whatever the caller's own seat.
   * A customer of a well-formed mailbox thread sees one entry. The data
   * integrity anomaly of a thread seating two businesses gives several, and
   * `mailboxIdentityId` stays undefined there. The customer's identity-block
   * rule reads every entry, as its SQL twin does, so that anomaly fails
   * closed in memory too.
   */
  readonly otherMailboxIdentityIds: ReadonlyArray<string>;
  /**
   * A staff caller's customer: the one other seat whose identity differs
   * from the mailbox identity. `undefined` for a customer caller, for an
   * ordinary thread, and for the data integrity anomaly of zero or several
   * such seats, which this reports without guessing between them.
   */
  readonly mailboxCustomerSeat: ConversationParticipant | undefined;
  /**
   * A customer's view of a mailbox thread: every staff seat, departed ones
   * included (see `describeDirectThreadSeats`). Empty otherwise.
   */
  readonly mailboxStaffSeats: ReadonlyArray<ConversationParticipant>;
  /**
   * Some seat's identity kind did not resolve. An unresolved identity never
   * counts as personal, so a thread in this state with no mailbox identity
   * confirmed is one this caller cannot safely attribute to any single human.
   */
  readonly hasUnresolvedSeatIdentity: boolean;
  /**
   * The seats whose watermarks and connection speak for the other side of
   * this thread, from this caller's view: the customer's one seat for a
   * staff caller, every staff seat for a customer, the single counterpart
   * of an ordinary DM, and none at all when the seats cannot be attributed
   * (the customer seat of a staff caller is ambiguous, or an identity is
   * unresolved and no mailbox is confirmed). Empty means every
   * counterpart-specific field reads null.
   */
  readonly counterpartSeats: ReadonlyArray<ConversationParticipant>;
  /**
   * Every other seat exactly as described, in the order it was given, so
   * `renderDirectCounterpart` reads the same seats this description was
   * built from.
   */
  readonly otherSeats: ReadonlyArray<ConversationParticipant>;
}

/** The shape for a group or official thread, which has no single counterpart.
 *  Frozen, arrays included, since every caller shares this one object. */
export const NOT_A_DIRECT_THREAD: DirectThreadSeats = Object.freeze({
  isCallerMailboxSeat: false,
  mailboxIdentityId: undefined,
  otherMailboxIdentityIds: Object.freeze([]),
  mailboxCustomerSeat: undefined,
  mailboxStaffSeats: Object.freeze([]),
  hasUnresolvedSeatIdentity: false,
  counterpartSeats: Object.freeze([]),
  otherSeats: Object.freeze([]),
});

/**
 * Describes one DIRECT, non-official thread's seats for the caller whose own
 * seat carries `callerIdentityId`. `otherSeats` is every other participant
 * row of the thread, in whatever order a query returned them; nothing here
 * depends on that order.
 *
 * Departed seats count. A staff member who left the mailbox keeps their row
 * with `leftAt` stamped (`IdentityMailboxSyncService`), and this function
 * reads every row it is given, `leftAt` or not, because the read surface
 * shows history that departed staff took part in. A caller that needs the
 * people who can act NOW (a broadcast or push audience) uses
 * `partitionMailboxThreadSeats` with `shouldIncludeDepartedSeats: false`.
 */
export function describeDirectThreadSeats(
  callerIdentityId: string,
  otherSeats: ConversationParticipant[],
  identityKindById: ReadonlyMap<string, IdentityKind>,
): DirectThreadSeats {
  const callerIdentityKind = identityKindById.get(callerIdentityId);
  const isCallerMailboxSeat = Boolean(
    callerIdentityKind && callerIdentityKind !== IdentityKind.Profile,
  );
  const otherMailboxIdentityIds = [
    ...new Set(
      otherSeats
        .map((seat) => seat.identityId)
        .filter((identityId) => {
          const kind = identityKindById.get(identityId);
          return kind != null && kind !== IdentityKind.Profile;
        }),
    ),
  ];
  let mailboxIdentityId: string | undefined;
  if (isCallerMailboxSeat) {
    mailboxIdentityId = callerIdentityId;
  } else if (otherMailboxIdentityIds.length === 1) {
    mailboxIdentityId = otherMailboxIdentityIds[0];
  }
  let mailboxCustomerSeat: ConversationParticipant | undefined;
  if (isCallerMailboxSeat && mailboxIdentityId) {
    const candidates = otherSeats.filter(
      (seat) => seat.identityId !== mailboxIdentityId,
    );
    mailboxCustomerSeat = candidates.length === 1 ? candidates[0] : undefined;
  }
  const mailboxStaffSeats =
    !isCallerMailboxSeat && mailboxIdentityId
      ? otherSeats.filter((seat) => seat.identityId === mailboxIdentityId)
      : [];
  const hasUnresolvedSeatIdentity = [
    callerIdentityId,
    ...otherSeats.map((seat) => seat.identityId),
  ].some((identityId) => !identityKindById.has(identityId));
  let counterpartSeats: ReadonlyArray<ConversationParticipant>;
  if (isCallerMailboxSeat && mailboxIdentityId) {
    counterpartSeats = mailboxCustomerSeat ? [mailboxCustomerSeat] : [];
  } else if (mailboxIdentityId) {
    counterpartSeats = mailboxStaffSeats;
  } else if (hasUnresolvedSeatIdentity) {
    counterpartSeats = [];
  } else {
    counterpartSeats = otherSeats.slice(0, 1);
  }
  return {
    isCallerMailboxSeat,
    mailboxIdentityId,
    otherMailboxIdentityIds,
    mailboxCustomerSeat,
    mailboxStaffSeats,
    hasUnresolvedSeatIdentity,
    counterpartSeats,
    otherSeats,
  };
}

/**
 * Task 13c: the seats of one DIRECT, non-official thread partitioned by what
 * they speak for, independent of who is asking: the mailbox identity, the
 * customer's seat, and the staff seats. For code that addresses the thread
 * as a whole, a socket or push audience for example, which has no caller of
 * its own to describe the thread from.
 *
 * `undefined` for an ordinary member thread, and for a thread whose seats
 * cannot be partitioned with certainty: an unresolved identity, more than one
 * distinct mailbox identity, or anything other than exactly one customer
 * seat. `shouldIncludeDepartedSeats: false` drops every seat with `leftAt`
 * set before partitioning, so a staff member who left the mailbox is outside
 * the audience.
 */
export function partitionMailboxThreadSeats(
  seats: ReadonlyArray<ConversationParticipant>,
  identityKindById: ReadonlyMap<string, IdentityKind>,
  options: { shouldIncludeDepartedSeats: boolean },
):
  | {
      mailboxIdentityId: string;
      customerSeat: ConversationParticipant;
      staffSeats: ReadonlyArray<ConversationParticipant>;
    }
  | undefined {
  const consideredSeats = options.shouldIncludeDepartedSeats
    ? seats
    : seats.filter((seat) => seat.leftAt == null);
  if (consideredSeats.some((seat) => !identityKindById.has(seat.identityId))) {
    return undefined;
  }
  const mailboxIdentityIds = [
    ...new Set(
      consideredSeats
        .map((seat) => seat.identityId)
        .filter(
          (identityId) =>
            identityKindById.get(identityId) !== IdentityKind.Profile,
        ),
    ),
  ];
  if (mailboxIdentityIds.length !== 1) {
    return undefined;
  }
  const mailboxIdentityId = mailboxIdentityIds[0]!;
  const customerSeats = consideredSeats.filter(
    (seat) => seat.identityId !== mailboxIdentityId,
  );
  if (customerSeats.length !== 1) {
    return undefined;
  }
  return {
    mailboxIdentityId,
    customerSeat: customerSeats[0]!,
    staffSeats: consideredSeats.filter(
      (seat) => seat.identityId === mailboxIdentityId,
    ),
  };
}

/**
 * Task 13e: whether every seat of a direct thread resolved to a profile
 * identity, the one condition under which the thread is genuinely personal,
 * so an audience built for it may skip the mailbox rules. A mailbox seat, or
 * a seat whose identity did not resolve, makes the thread something else.
 * The live socket frames and the push notifications both route on this.
 */
export function isEverySeatPersonal(
  seats: ReadonlyArray<Pick<ConversationParticipant, 'identityId'>>,
  identityKindById: ReadonlyMap<string, IdentityKind>,
): boolean {
  return seats.every(
    (seat) => identityKindById.get(seat.identityId) === IdentityKind.Profile,
  );
}

/**
 * Task 13e: the users whose reactions a reader sees as ONE reactor, the
 * business, read from that reader's own `describeDirectThreadSeats`
 * description. For a customer reading a mailbox thread it is every seat of
 * the mailbox identity, departed ones included, so a reaction a departed
 * colleague made still counts as the business's. For a customer whose
 * thread has an unresolved seat and no confirmed mailbox, every other seat
 * counts as one, since none of them can be attributed to a person. Empty
 * for staff, whose shared inbox shows each colleague, and for an ordinary
 * thread. The REST reads, the "who reacted" list and the live `reaction`
 * frame all take their set from here, so they count alike.
 */
export function businessSeatUserIdsForViewer(
  viewerSeats: DirectThreadSeats,
): ReadonlySet<string> {
  if (viewerSeats.isCallerMailboxSeat) {
    return new Set();
  }
  if (viewerSeats.mailboxIdentityId) {
    return new Set(viewerSeats.mailboxStaffSeats.map((seat) => seat.userId));
  }
  if (viewerSeats.hasUnresolvedSeatIdentity) {
    return new Set(viewerSeats.otherSeats.map((seat) => seat.userId));
  }
  return new Set();
}

/**
 * Task 13e: `rows` with every business reaction under one key kept once,
 * the first one met, and every other reaction kept as it is. Counting the
 * result per key counts the business once, whichever path renders it.
 */
export function collapseBusinessReactions<
  Row extends { userId: string; key: string },
>(rows: ReadonlyArray<Row>, businessUserIds: ReadonlySet<string>): Row[] {
  const businessReactedKeys = new Set<string>();
  return rows.filter((row) => {
    if (!businessUserIds.has(row.userId)) {
      return true;
    }
    if (businessReactedKeys.has(row.key)) {
      return false;
    }
    businessReactedKeys.add(row.key);
    return true;
  });
}

/** A partition `partitionMailboxThreadSeats` could make with certainty. */
export type MailboxThreadPartition = NonNullable<
  ReturnType<typeof partitionMailboxThreadSeats>
>;

/**
 * Task 14: a member's block of a whole business, persona or company, read
 * into memory for the in-memory twins below. Each entry is one
 * `identity_blocks` row, keyed by `mailboxIdentityBlockKey`, so a caller
 * that loaded the rows for a whole page of threads answers every thread
 * from the same set.
 */
export type MailboxIdentityBlockKeys = ReadonlySet<string>;

/** Task 14: no identity block at all, for a caller whose question concerns a
 *  person block alone. */
export const NO_MAILBOX_IDENTITY_BLOCKS: MailboxIdentityBlockKeys = new Set();

/** Task 14: the key of one `identity_blocks` row in a
 *  `MailboxIdentityBlockKeys` set. */
export function mailboxIdentityBlockKey(
  blockerUserId: string,
  identityId: string,
): string {
  return `${blockerUserId}:${identityId}`;
}

/**
 * Task 14: the `identity_blocks` rows that can decide `ownSeat`'s access to
 * the thread `seats` describes. For a staff caller, every other seat
 * speaking for a different identity may have blocked the caller's mailbox
 * identity (the twin of `blocking_customer_seat` in
 * `blockedStaffSeatPredicate`). For a customer, their own block of any
 * business the other seats speak for (the twin of
 * `identityBlockedCustomerSeatPredicate`), every one of them on a thread
 * seating two. Empty for an ordinary thread, which no identity block
 * reaches.
 */
export function mailboxIdentityBlockCandidates(
  ownSeat: Pick<ConversationParticipant, 'userId'>,
  seats: DirectThreadSeats,
): Array<{ blockerUserId: string; identityId: string }> {
  if (!seats.isCallerMailboxSeat) {
    return seats.otherMailboxIdentityIds.map((identityId) => ({
      blockerUserId: ownSeat.userId,
      identityId,
    }));
  }
  const mailboxIdentityId = seats.mailboxIdentityId;
  if (!mailboxIdentityId) {
    return [];
  }
  return seats.otherSeats
    .filter((seat) => seat.identityId !== mailboxIdentityId)
    .map((seat) => ({
      blockerUserId: seat.userId,
      identityId: mailboxIdentityId,
    }));
}

/**
 * Task 14: the `identity_blocks` rows among `candidates`, in one batched
 * query (`BlockFilterService.identityBlocksAmong`), however many threads
 * the candidates came from. No candidates costs no query.
 */
export async function loadMailboxIdentityBlockKeys(
  candidates: ReadonlyArray<{ blockerUserId: string; identityId: string }>,
  blockFilter: Pick<BlockFilterService, 'identityBlocksAmong'>,
): Promise<MailboxIdentityBlockKeys> {
  if (candidates.length === 0) {
    return NO_MAILBOX_IDENTITY_BLOCKS;
  }
  const wantedKeys = new Set(
    candidates.map((candidate) =>
      mailboxIdentityBlockKey(candidate.blockerUserId, candidate.identityId),
    ),
  );
  const rows = await blockFilter.identityBlocksAmong(
    candidates.map((candidate) => candidate.blockerUserId),
    candidates.map((candidate) => candidate.identityId),
  );
  return new Set(
    rows
      .map((row) => mailboxIdentityBlockKey(row.blockerUserId, row.identityId))
      .filter((key) => wantedKeys.has(key)),
  );
}

/**
 * Task 13e: the seats of a partitioned mailbox thread that may still reach
 * it, the one home of this rule for every audience built from the
 * partition (the live socket frames and the push notifications both call
 * this). The partition is not block-aware, so every seat goes through
 * `isSeatExcludedFromMailbox`, the rule every REST surface applies: a block
 * in either direction between a staff member and the customer removes that
 * staff member's own access, and the customer and every other colleague
 * keep theirs. Task 14a: a departed staff seat is left out by the same
 * call, whether or not the partition already dropped it. Task 14: when the
 * customer blocked the mailbox identity itself, the thread reaches nobody,
 * so `customerSeat` is `undefined` and `staffSeats` is empty.
 *
 * Costs one batched `BlockFilterService.blockedUserIds` query keyed on the
 * customer, which reads blocks in both directions, and one
 * `BlockFilterService.identityBlocksAmong` query for the customer and the
 * mailbox identity.
 */
export async function loadReachableMailboxSeats(
  partition: MailboxThreadPartition,
  identityKindById: ReadonlyMap<string, IdentityKind>,
  blockFilter: Pick<
    BlockFilterService,
    'blockedUserIds' | 'identityBlocksAmong'
  >,
): Promise<{
  customerSeat: ConversationParticipant | undefined;
  staffSeats: ConversationParticipant[];
}> {
  const customerSeat = partition.customerSeat;
  const customerUserId = customerSeat.userId;
  const [staffBlockedWithCustomerUserIds, identityBlockKeys] =
    await Promise.all([
      blockFilter.blockedUserIds(
        customerUserId,
        partition.staffSeats.map((seat) => seat.userId),
      ),
      loadMailboxIdentityBlockKeys(
        [
          {
            blockerUserId: customerUserId,
            identityId: partition.mailboxIdentityId,
          },
        ],
        blockFilter,
      ),
    ]);
  const partitionedSeats = [customerSeat, ...partition.staffSeats];
  const describedFrom = (ownSeat: ConversationParticipant) =>
    describeDirectThreadSeats(
      ownSeat.identityId,
      partitionedSeats.filter((seat) => seat !== ownSeat),
      identityKindById,
    );
  const isCustomerReachable = !isSeatExcludedFromMailbox(
    customerSeat,
    describedFrom(customerSeat),
    new Set<string>(),
    identityBlockKeys,
  );
  return {
    customerSeat: isCustomerReachable ? customerSeat : undefined,
    staffSeats: partition.staffSeats.filter(
      (staffSeat) =>
        !isSeatExcludedFromMailbox(
          staffSeat,
          describedFrom(staffSeat),
          staffBlockedWithCustomerUserIds.has(staffSeat.userId)
            ? new Set([customerUserId])
            : new Set<string>(),
          identityBlockKeys,
        ),
    ),
  };
}

/**
 * Task 13c fix round 1: whether a person-to-person block removes THIS
 * caller's own access to a mailbox thread. A block, in either direction,
 * between a staff caller and a seat speaking for a different identity (the
 * customer) takes that staff member out of the thread, so a customer who
 * blocked someone for their safety stays out of that person's sight when
 * they write to the business that person works for. The customer's own view
 * is unchanged, and every colleague without a block keeps the thread, so
 * the business keeps answering. `blockedUserIds` holds every user blocked
 * either way with the caller.
 *
 * Task 14: the customer's block of the mailbox identity itself takes EVERY
 * staff seat out, read from `identityBlockKeys`
 * (`loadMailboxIdentityBlockKeys` over `mailboxIdentityBlockCandidates`).
 * The in-memory twin of `blockedStaffSeatPredicate`.
 */
export function isStaffSeatExcludedByBlock(
  seats: DirectThreadSeats,
  blockedUserIds: ReadonlySet<string>,
  identityBlockKeys: MailboxIdentityBlockKeys,
): boolean {
  const mailboxIdentityId = seats.mailboxIdentityId;
  if (!seats.isCallerMailboxSeat || !mailboxIdentityId) {
    return false;
  }
  return seats.otherSeats.some(
    (seat) =>
      seat.identityId !== mailboxIdentityId &&
      (blockedUserIds.has(seat.userId) ||
        identityBlockKeys.has(
          mailboxIdentityBlockKey(seat.userId, mailboxIdentityId),
        )),
  );
}

/**
 * Task 14: whether the caller's own seat is the CUSTOMER seat of a mailbox
 * thread and the customer has blocked a business another seat speaks for.
 * Blocking a business severs every thread with it for both sides, so the
 * customer's seat reads, writes and joins nothing while the block stands,
 * as the business's staff seats do through `isStaffSeatExcludedByBlock`.
 * Lifting the block restores it, since nothing is written to the seat.
 * Every business among the other seats is read, as the SQL reads every
 * other non-profile seat, so a thread seating two businesses (a data
 * integrity anomaly with no single `mailboxIdentityId`) is excluded when
 * either is blocked. `seats` describes the thread from `ownSeat`. The
 * in-memory twin of `identityBlockedCustomerSeatPredicate`.
 */
export function isCustomerSeatExcludedByIdentityBlock(
  ownSeat: Pick<ConversationParticipant, 'userId'>,
  seats: DirectThreadSeats,
  identityBlockKeys: MailboxIdentityBlockKeys,
): boolean {
  return (
    !seats.isCallerMailboxSeat &&
    seats.otherMailboxIdentityIds.some((identityId) =>
      identityBlockKeys.has(
        mailboxIdentityBlockKey(ownSeat.userId, identityId),
      ),
    )
  );
}

/**
 * Task 14a: whether the caller's own seat is a staff seat of a mailbox
 * thread that the staff member has left. `IdentityMailboxSyncService` stamps
 * `leftAt` on every seat of a mailbox when its holder stops being staff
 * there (a co-manager removed, a listing transferred, a persona handed
 * over). The customer wrote to the business, so a former employee has no
 * standing in its customers' threads: such a seat reads, writes and joins
 * nothing, as though it were never seated. A group leaver's seat and a
 * customer's seat speak for the member themself and never match. Rehiring
 * clears `leftAt` on the same row, which restores access.
 *
 * `seats` describes the thread from `ownSeat`, as `describeDirectThreadSeats`
 * builds it. The in-memory twin of `departedStaffSeatPredicate`.
 */
export function isDepartedStaffSeat(
  ownSeat: Pick<ConversationParticipant, 'leftAt'>,
  seats: DirectThreadSeats,
): boolean {
  return Boolean(
    seats.isCallerMailboxSeat &&
    seats.mailboxIdentityId &&
    ownSeat.leftAt != null,
  );
}

/**
 * Task 14a: whether the caller's own seat is out of a mailbox thread, for
 * either of the two reasons a staff seat can be: a block by or of the
 * customer, person or identity (`isStaffSeatExcludedByBlock`), or a
 * departure from the business
 * (`isDepartedStaffSeat`). Task 14: every path reaches it through
 * `isSeatExcludedFromMailbox`, which adds the customer's own seat. The
 * in-memory twin of `staffSeatExcludedFromMailboxPredicate`.
 */
export function isStaffSeatExcludedFromMailbox(
  ownSeat: Pick<ConversationParticipant, 'leftAt'>,
  seats: DirectThreadSeats,
  blockedUserIds: ReadonlySet<string>,
  identityBlockKeys: MailboxIdentityBlockKeys,
): boolean {
  return (
    isDepartedStaffSeat(ownSeat, seats) ||
    isStaffSeatExcludedByBlock(seats, blockedUserIds, identityBlockKeys)
  );
}

/**
 * Task 14: whether the caller's own seat, staff or customer, is out of a
 * mailbox thread: a staff seat for the reasons
 * `isStaffSeatExcludedFromMailbox` gives, and the customer's seat once the
 * customer blocked the mailbox identity
 * (`isCustomerSeatExcludedByIdentityBlock`). Every in-memory path that
 * decides a seat's access to a mailbox thread (the inbox, the live join,
 * the live and push audiences) asks this one function. The in-memory twin
 * of `seatExcludedFromMailboxPredicate`.
 */
export function isSeatExcludedFromMailbox(
  ownSeat: Pick<ConversationParticipant, 'leftAt' | 'userId'>,
  seats: DirectThreadSeats,
  blockedUserIds: ReadonlySet<string>,
  identityBlockKeys: MailboxIdentityBlockKeys,
): boolean {
  return (
    isStaffSeatExcludedFromMailbox(
      ownSeat,
      seats,
      blockedUserIds,
      identityBlockKeys,
    ) ||
    isCustomerSeatExcludedByIdentityBlock(ownSeat, seats, identityBlockKeys)
  );
}

/**
 * The conversation-level counterpart of a DIRECT, non-official thread, as the
 * caller sees it in a header or a result group: the customer's own profile
 * for a staff caller, and the business itself for a customer. A header
 * describes the whole thread, so a business renders with no staff first name
 * at all; per-message attribution (`renderMessageSender`) is where the human
 * who actually wrote a reply can be named.
 *
 * Returns null for a staff caller whose customer seat is ambiguous, a data
 * integrity anomaly with a meaning of its own, which the null keeps visible.
 * `FORMER_IDENTITY_AUTHOR` covers a counterpart with no seat left or whose
 * identity did not resolve: `identity_id` cascades on delete, so a live seat
 * always points at a live identity, and an unresolved one renders the
 * placeholder.
 */
export function renderDirectCounterpart(
  seats: DirectThreadSeats,
  identityKindById: ReadonlyMap<string, IdentityKind>,
  identityDescriptionById: ReadonlyMap<string, IdentityDescription>,
  profileByUser: ReadonlyMap<string, Profile>,
): AuthorSummary | null {
  const isStaffView = Boolean(
    seats.isCallerMailboxSeat && seats.mailboxIdentityId,
  );
  if (isStaffView && !seats.mailboxCustomerSeat) {
    return null;
  }
  const counterpartSeat = isStaffView
    ? seats.mailboxCustomerSeat
    : seats.otherSeats[0];
  if (!counterpartSeat) {
    return FORMER_IDENTITY_AUTHOR;
  }
  const identityKind = identityKindById.get(counterpartSeat.identityId);
  const identityDescription = identityDescriptionById.get(
    counterpartSeat.identityId,
  );
  if (
    identityKind &&
    identityKind !== IdentityKind.Profile &&
    identityDescription
  ) {
    return buildAuthorSummary({
      identity: { id: counterpartSeat.identityId, kind: identityKind },
      identityDisplayName: identityDescription.displayName,
      identityHandle: identityDescription.handle ?? '',
      identityAvatarUrl: identityDescription.avatarUrl,
      staffFirstName: null,
    });
  }
  if (identityKind === IdentityKind.Profile) {
    return toAuthorSummary(profileByUser.get(counterpartSeat.userId));
  }
  return FORMER_IDENTITY_AUTHOR;
}

/**
 * Task 13c: SQL that holds when the conversation `conversationIdExpression`
 * seats a business/persona/company identity, the database-side twin of
 * `DirectThreadSeats.mailboxIdentityId` being set. On such a thread a
 * person-to-person block removes only the blocked staff member's own access
 * (`blockedStaffSeatPredicate`), and the customer and every colleague keep
 * theirs. Every SQL block check composes this to set that thread apart from
 * an ordinary DM, so the inbox pre-filter, the write gate and the live-room
 * eviction agree. The
 * aliases are lowercase and quoted at every reference.
 */
export function mailboxThreadPredicate(
  conversationIdExpression: string,
): string {
  return `EXISTS (
    SELECT 1 FROM "conversation_participants" "mailbox_seat"
    INNER JOIN "identities" "mailbox_identity"
      ON "mailbox_identity"."id" = "mailbox_seat"."identity_id"
    WHERE "mailbox_seat"."conversation_id" = ${conversationIdExpression}
      AND "mailbox_identity"."kind" <> 'profile'
  )`;
}

/**
 * Task 13c fix round 1: SQL that holds when `userIdExpression`'s own seat in
 * the conversation `conversationIdExpression` is a mailbox (staff) seat of a
 * DIRECT, non-official thread and a block exists, in either direction,
 * between that user and a seat speaking for a different identity: the
 * database-side twin of `isStaffSeatExcludedByBlock`. Task 14a: reads and
 * writes compose it through `staffSeatExcludedFromMailboxPredicate`, beside
 * the departed-staff rule, as `NOT ...` wherever they must leave that staff
 * member out of the thread. The aliases are lowercase and quoted at every
 * reference.
 *
 * Task 14: the same seat is also excluded when that customer holds an
 * `identity_blocks` row for the staff seat's own identity, the mailbox
 * identity, so a customer's block of a whole business takes every staff
 * seat of it out of that customer's threads. The two kinds of block are
 * separate `EXISTS` arms under one customer seat.
 */
export function blockedStaffSeatPredicate(
  conversationIdExpression: string,
  userIdExpression: string,
): string {
  return `EXISTS (
    SELECT 1 FROM "conversation_participants" "blocked_staff_seat"
    INNER JOIN "identities" "blocked_staff_identity"
      ON "blocked_staff_identity"."id" = "blocked_staff_seat"."identity_id"
    INNER JOIN "conversations" "blocked_staff_conversation"
      ON "blocked_staff_conversation"."id" = "blocked_staff_seat"."conversation_id"
    INNER JOIN "conversation_participants" "blocking_customer_seat"
      ON "blocking_customer_seat"."conversation_id" = "blocked_staff_seat"."conversation_id"
      AND "blocking_customer_seat"."identity_id" <> "blocked_staff_seat"."identity_id"
    WHERE "blocked_staff_seat"."conversation_id" = ${conversationIdExpression}
      AND "blocked_staff_seat"."user_id" = ${userIdExpression}
      AND "blocked_staff_identity"."kind" <> 'profile'
      AND "blocked_staff_conversation"."kind" <> 'group'
      AND "blocked_staff_conversation"."is_official" = false
      AND (
        EXISTS (
          SELECT 1 FROM "blocks" "staff_customer_block"
          WHERE ("staff_customer_block"."blocker_id" = "blocked_staff_seat"."user_id"
              AND "staff_customer_block"."blocked_id" = "blocking_customer_seat"."user_id")
            OR ("staff_customer_block"."blocked_id" = "blocked_staff_seat"."user_id"
              AND "staff_customer_block"."blocker_id" = "blocking_customer_seat"."user_id")
        )
        OR EXISTS (
          SELECT 1 FROM "identity_blocks" "staff_business_identity_block"
          WHERE "staff_business_identity_block"."blocker_user_id" = "blocking_customer_seat"."user_id"
            AND "staff_business_identity_block"."identity_id" = "blocked_staff_seat"."identity_id"
        )
      )
  )`;
}

/**
 * Task 14: SQL that holds when `userIdExpression`'s own seat in the
 * conversation `conversationIdExpression` is the CUSTOMER seat (a `profile`
 * identity) of a DIRECT, non-official thread, and that customer holds an
 * `identity_blocks` row for the identity another seat of the thread speaks
 * for, a business, persona or company: the database-side twin of
 * `isCustomerSeatExcludedByIdentityBlock`. Reads and writes compose it
 * through `seatExcludedFromMailboxPredicate`. The aliases are lowercase and
 * quoted at every reference, and it binds no parameter of its own.
 */
export function identityBlockedCustomerSeatPredicate(
  conversationIdExpression: string,
  userIdExpression: string,
): string {
  return `EXISTS (
    SELECT 1 FROM "conversation_participants" "identity_blocking_customer_seat"
    INNER JOIN "identities" "identity_blocking_customer_identity"
      ON "identity_blocking_customer_identity"."id" = "identity_blocking_customer_seat"."identity_id"
    INNER JOIN "conversations" "identity_blocking_customer_conversation"
      ON "identity_blocking_customer_conversation"."id" = "identity_blocking_customer_seat"."conversation_id"
    INNER JOIN "conversation_participants" "identity_blocked_business_seat"
      ON "identity_blocked_business_seat"."conversation_id" = "identity_blocking_customer_seat"."conversation_id"
      AND "identity_blocked_business_seat"."identity_id" <> "identity_blocking_customer_seat"."identity_id"
    INNER JOIN "identities" "identity_blocked_business_identity"
      ON "identity_blocked_business_identity"."id" = "identity_blocked_business_seat"."identity_id"
    INNER JOIN "identity_blocks" "customer_business_identity_block"
      ON "customer_business_identity_block"."blocker_user_id" = "identity_blocking_customer_seat"."user_id"
      AND "customer_business_identity_block"."identity_id" = "identity_blocked_business_seat"."identity_id"
    WHERE "identity_blocking_customer_seat"."conversation_id" = ${conversationIdExpression}
      AND "identity_blocking_customer_seat"."user_id" = ${userIdExpression}
      AND "identity_blocking_customer_identity"."kind" = 'profile'
      AND "identity_blocked_business_identity"."kind" <> 'profile'
      AND "identity_blocking_customer_conversation"."kind" <> 'group'
      AND "identity_blocking_customer_conversation"."is_official" = false
  )`;
}

/**
 * Task 14a: SQL that holds when `userIdExpression`'s own seat in the
 * conversation `conversationIdExpression` is a staff seat of a DIRECT,
 * non-official thread that the staff member has left (`left_at` set on a
 * seat speaking for a business/persona/company identity): the
 * database-side twin of `isDepartedStaffSeat`. The aliases are lowercase
 * and quoted at every reference.
 */
export function departedStaffSeatPredicate(
  conversationIdExpression: string,
  userIdExpression: string,
): string {
  return `EXISTS (
    SELECT 1 FROM "conversation_participants" "departed_staff_seat"
    INNER JOIN "identities" "departed_staff_identity"
      ON "departed_staff_identity"."id" = "departed_staff_seat"."identity_id"
    INNER JOIN "conversations" "departed_staff_conversation"
      ON "departed_staff_conversation"."id" = "departed_staff_seat"."conversation_id"
    WHERE "departed_staff_seat"."conversation_id" = ${conversationIdExpression}
      AND "departed_staff_seat"."user_id" = ${userIdExpression}
      AND "departed_staff_seat"."left_at" IS NOT NULL
      AND "departed_staff_identity"."kind" <> 'profile'
      AND "departed_staff_conversation"."kind" <> 'group'
      AND "departed_staff_conversation"."is_official" = false
  )`;
}

/**
 * Task 14a: SQL that holds when `userIdExpression`'s own staff seat in the
 * conversation `conversationIdExpression` is out of that mailbox thread,
 * blocked with its customer (`blockedStaffSeatPredicate`) or departed from
 * the business (`departedStaffSeatPredicate`): the database-side twin of
 * `isStaffSeatExcludedFromMailbox`. Every read and write that must leave
 * such a staff member out of the thread composes this as `NOT ...`, so the
 * two rules reach every path together. A customer's seat and a group
 * leaver's seat speak for a `profile` identity and never match. Task 14:
 * every path reaches it through `seatExcludedFromMailboxPredicate`, which
 * adds the customer's own seat.
 */
export function staffSeatExcludedFromMailboxPredicate(
  conversationIdExpression: string,
  userIdExpression: string,
): string {
  return `(${blockedStaffSeatPredicate(
    conversationIdExpression,
    userIdExpression,
  )} OR ${departedStaffSeatPredicate(
    conversationIdExpression,
    userIdExpression,
  )})`;
}

/**
 * Task 14: SQL that holds when `userIdExpression`'s own seat in the
 * conversation `conversationIdExpression` is out of that mailbox thread,
 * whether it is a staff seat (`staffSeatExcludedFromMailboxPredicate`: a
 * person block with the customer, the customer's block of the business, or
 * a departure) or the customer's seat after the customer blocked the
 * business (`identityBlockedCustomerSeatPredicate`): the database-side twin
 * of `isSeatExcludedFromMailbox`. Every read and write that must leave an
 * excluded seat out of the thread composes this as `NOT ...`, so every rule
 * reaches every path together. A group seat and an ordinary DM seat never
 * match.
 */
export function seatExcludedFromMailboxPredicate(
  conversationIdExpression: string,
  userIdExpression: string,
): string {
  return `(${staffSeatExcludedFromMailboxPredicate(
    conversationIdExpression,
    userIdExpression,
  )} OR ${identityBlockedCustomerSeatPredicate(
    conversationIdExpression,
    userIdExpression,
  )})`;
}

/** A canonical uuid, for guarding a text value before it is cast. */
const STORED_CONVERSATION_ID_UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * Task 13g: `seatExcludedFromMailboxPredicate` for a row that names its
 * thread as TEXT, a stored copy of thread content such as a mention
 * notification's `payload ->> 'conversationId'`. Such a row was written
 * while the reader still had the thread, and it keeps a copy of the
 * thread's content after a block or a departure, so every read of it
 * composes this as `NOT ...` to leave the row out for exactly as long as the
 * reader's seat stays excluded. Lifting the block, or seating the reader
 * again, brings the row back, since nothing is deleted. Task 14: the reader
 * may be the customer too, once they blocked the business.
 *
 * The text is cast to uuid only when it has a uuid's shape, inside a `CASE`,
 * so a malformed stored value reads as "no thread" and the cast can never
 * fail the whole query. NULL text holds nothing, so a row that names no
 * thread is never excluded.
 */
export function seatExcludedFromMailboxByStoredConversationIdPredicate(
  conversationIdTextExpression: string,
  userIdExpression: string,
): string {
  const conversationIdExpression = `(CASE WHEN ${conversationIdTextExpression} ~* '${STORED_CONVERSATION_ID_UUID_PATTERN}' THEN CAST(${conversationIdTextExpression} AS uuid) END)`;
  return seatExcludedFromMailboxPredicate(
    conversationIdExpression,
    userIdExpression,
  );
}

/**
 * Task 13h: SQL that holds when a row created at `createdAtExpression` sits
 * at or before the history floor of the seat `seatAlias`, and that seat is a
 * MAILBOX STAFF seat: it speaks for a business, persona or company identity
 * in a DIRECT, non-official thread. A co-manager seated when a personal
 * thread moved into a business mailbox holds a floor at its first enquiry,
 * and sees nothing created at or before it: the message, its attachments,
 * its reactions, and a quote of it inside a later reply. This is the one
 * definition of that rule, and the staff-seat condition lives inside it, so
 * a member's own "clear chat" on a personal or group seat never matches and
 * keeps its earlier behaviour: quotes, downloads, forwards and live frames
 * stay as they were. The floor is the seat's `history_floor_at`, which only
 * seating a staff member writes. A staff member's own "clear chat" writes
 * `cleared_at` alone, so it stays personal on a mailbox seat as well: it
 * hides history from their own list and nothing else. The comparison runs
 * in the database at full precision. `seatAlias` names a
 * `conversation_participants` row, read through its `history_floor_at`,
 * `identity_id` and `conversation_id` columns. The subquery aliases are
 * lowercase and quoted at every reference. Compose it as `NOT ...` to keep
 * only what the seat may see. `isCoveredByMailboxStaffFloor` is its
 * in-memory twin.
 */
export function mailboxStaffHistoryFloorCoversPredicate(
  createdAtExpression: string,
  seatAlias: string,
): string {
  return `(${seatAlias}.history_floor_at IS NOT NULL
    AND ${createdAtExpression} <= ${seatAlias}.history_floor_at
    AND EXISTS (
      SELECT 1 FROM "identities" "floor_staff_identity"
      INNER JOIN "conversations" "floor_staff_conversation"
        ON "floor_staff_conversation"."id" = ${seatAlias}.conversation_id
      WHERE "floor_staff_identity"."id" = ${seatAlias}.identity_id
        AND "floor_staff_identity"."kind" <> 'profile'
        AND "floor_staff_conversation"."kind" <> 'group'
        AND "floor_staff_conversation"."is_official" = false
    ))`;
}

/**
 * Task 13h: the in-memory oracle of `mailboxStaffHistoryFloorCoversPredicate`.
 * The spec stand-ins model the SQL with it, and `ReportsService` checks a
 * message report against it. It is kept beside the SQL so the two change
 * together: it holds only for a mailbox staff seat, exactly as the
 * predicate does, and an edit to either belongs in both. node-pg truncates
 * both instants to the millisecond on load, and truncation keeps order, so
 * a message truly at or before the floor is always covered here, and one a
 * few microseconds after it inside the floor's own millisecond is covered
 * too: the rounding errs toward hiding.
 */
export function isCoveredByMailboxStaffFloor(
  createdAt: Date,
  seat: {
    historyFloorAt: Date | null | undefined;
    identityKind: IdentityKind | null | undefined;
    isGroupConversation: boolean;
    isOfficialConversation: boolean;
  },
): boolean {
  return (
    seat.identityKind != null &&
    seat.identityKind !== IdentityKind.Profile &&
    !seat.isGroupConversation &&
    !seat.isOfficialConversation &&
    seat.historyFloorAt != null &&
    createdAt.getTime() <= seat.historyFloorAt.getTime()
  );
}
