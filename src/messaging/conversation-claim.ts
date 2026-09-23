import type { Repository } from 'typeorm';
import type { CursorPage } from '../common/cursor-pagination';
import type { Profile } from '../users/entities/profile.entity';
import type { Conversation } from './entities/conversation.entity';
import {
  AuthorSummary,
  ConversationResponse,
  toAuthorSummary,
} from './message-response';

/**
 * Task 19: a shared business mailbox thread's claim changed. Emitted by
 * `ConversationsService` after a claim, a take-over or a release that
 * actually changed the row (`affected === 1`), post-commit and best-effort,
 * so a relay failure never fails the write. Task 23 emits it for the claim a
 * reply takes (`isImplicit: true`), and Task 25 for the system release of a
 * claimant who left the business (`actorUserId: null`).
 *
 * `MailboxStaffRelayListener` turns it into the staff-only
 * `conversation:claim` socket frame.
 */
export const CONVERSATION_CLAIM_CHANGED = 'conversation.claim.changed';

/** The three writes that change a claim. */
export type ConversationClaimChange = 'claimed' | 'released' | 'taken_over';

/** See {@link CONVERSATION_CLAIM_CHANGED}. */
export interface ConversationClaimChangedEvent {
  conversationId: string;
  /** The business, persona or company identity the thread belongs to. */
  mailboxIdentityId: string;
  change: ConversationClaimChange;
  /** True when a reply claimed the thread as a side effect (Task 23). */
  isImplicit: boolean;
  /** Who made the change. Null when the system released the claim of a
   *  claimant who left the business (Task 25). */
  actorUserId: string | null;
  /** The claimant after the change. Null after a release. */
  claimedByUserId: string | null;
  /** Whose claim ended with this change: the released claimant, or the
   *  colleague a take-over took it from. Null for an ordinary claim. */
  previousClaimantUserId: string | null;
  changedAt: Date;
}

/**
 * The `conversation:claim` socket frame. It names staff members, so it goes
 * to the thread's reachable STAFF seats only, each through its own
 * `user:<userId>` room. The customer's seat and the conversation room
 * receive nothing.
 */
export const CONVERSATION_CLAIM_FRAME = 'conversation:claim';

/** Payload of {@link CONVERSATION_CLAIM_FRAME}. */
export interface ConversationClaimFrame {
  conversationId: string;
  mailboxIdentityId: string;
  change: ConversationClaimChange;
  isImplicit: boolean;
  /** Null: the system released it. */
  actor: AuthorSummary | null;
  /** The claimant's user id after the change, null after a release. A
   *  colleague passes it as `fromUserId` to take the thread over. */
  claimedByUserId: string | null;
  claimedBy: AuthorSummary | null;
  previousClaimant: AuthorSummary | null;
  claimedAt: string | null;
  changedAt: string;
}

/**
 * `POST /conversations/:id/claim` response. `claimedBy` is the claimant's
 * author summary, rendered the same way the conversation read renders its
 * own `claimedBy` for staff, so the two always agree. A caller who lost the
 * race reads the winner here; a loser whose re-read found the thread
 * unclaimed reads `claimedByUserId: null` and `claimedBy: null`.
 */
export interface ClaimResponse {
  claimedByUserId: string | null;
  isNewlyClaimed: boolean;
  claimedBy: AuthorSummary | null;
  claimedAt: string | null;
}

/**
 * `POST /conversations/:id/claim/take-over` response: the claim as it now
 * stands, plus whose claim was taken. `previousClaimant` is null whenever
 * nothing was taken (`isNewlyClaimed: false`).
 */
export interface TakeOverClaimResponse extends ClaimResponse {
  previousClaimant: AuthorSummary | null;
}

/**
 * `DELETE /conversations/:id/claim` response: the claim as it stands after
 * the release. `isReleased` is true when this call released the thread
 * (`claimedByUserId` then reads null). When the claim changed between the
 * release's read and its write, nothing is written, `isReleased` is false,
 * and `claimedByUserId` / `claimedBy` name whoever holds the thread now.
 * `isNewlyClaimed` is always false.
 */
export interface ReleaseClaimResponse extends ClaimResponse {
  isReleased: boolean;
}

/**
 * The claim-change fields the conversation read adds for a STAFF caller of
 * the thread's mailbox, beside `claimedBy` and `claimedAt`. Each reads null
 * for a customer, the same way `claimedBy` does, because they name the
 * humans who staff the business.
 */
export interface StaffClaimFields {
  /** The current claimant's user id, null while unclaimed. A colleague
   *  passes it as `fromUserId` to take the thread over. */
  claimedByUserId: string | null;
  /** Who last released the claim. Null when nobody has, when a claim has
   *  been taken since, or when the system released it (Task 25). */
  claimReleasedBy: AuthorSummary | null;
  claimReleasedAt: string | null;
  /** Whose claim the current claimant took over. Null for an ordinary
   *  claim. */
  claimTakenOverFrom: AuthorSummary | null;
}

/** The conversation read as `ConversationsService` builds it. */
export type ConversationResponseWithStaffClaim = ConversationResponse &
  StaffClaimFields;

/** `GET /conversations`: one page of the inbox, each row carrying the
 *  staff-only claim fields. */
export type ConversationListPageWithStaffClaim =
  CursorPage<ConversationResponseWithStaffClaim>;

/** Staff claim fields for a caller who may not see them. */
export const NO_STAFF_CLAIM_FIELDS: StaffClaimFields = Object.freeze({
  claimedByUserId: null,
  claimReleasedBy: null,
  claimReleasedAt: null,
  claimTakenOverFrom: null,
});

/**
 * The claim-change fields a staff caller reads, from a conversation row and
 * the batched profiles the read already loaded. A user id with no loaded
 * profile renders null, like `claimedBy` does.
 *
 * `claimTakenOverFrom` describes the CURRENT claim, so it reads null while
 * the thread is unclaimed. A system release or an erased claimant account
 * (FK `ON DELETE SET NULL`) can leave the column set on an unclaimed row,
 * and staff then read a plain unclaimed thread.
 */
export function staffClaimFields(
  conversation: {
    claimedByUserId: string | null;
    claimReleasedByUserId: string | null;
    claimReleasedAt: Date | null;
    claimTakenOverFromUserId: string | null;
  },
  profileByUser: ReadonlyMap<string, Profile>,
): StaffClaimFields {
  return {
    claimedByUserId: conversation.claimedByUserId,
    claimReleasedBy: conversation.claimReleasedByUserId
      ? toAuthorSummary(profileByUser.get(conversation.claimReleasedByUserId))
      : null,
    claimReleasedAt: conversation.claimReleasedAt?.toISOString() ?? null,
    claimTakenOverFrom:
      conversation.claimedByUserId && conversation.claimTakenOverFromUserId
        ? toAuthorSummary(
            profileByUser.get(conversation.claimTakenOverFromUserId),
          )
        : null,
  };
}

/** The user ids a claim-change event names, deduplicated, for one batched
 *  profile read. */
export function claimEventUserIds(
  event: Pick<
    ConversationClaimChangedEvent,
    'actorUserId' | 'claimedByUserId' | 'previousClaimantUserId'
  >,
): string[] {
  return [
    ...new Set(
      [
        event.actorUserId,
        event.claimedByUserId,
        event.previousClaimantUserId,
      ].filter((userId): userId is string => userId !== null),
    ),
  ];
}

/** Renders a claim-change event as the staff-only socket frame. */
export function toConversationClaimFrame(
  event: ConversationClaimChangedEvent,
  profileByUser: ReadonlyMap<string, Profile>,
): ConversationClaimFrame {
  const summaryOf = (userId: string | null) =>
    userId ? toAuthorSummary(profileByUser.get(userId)) : null;
  return {
    conversationId: event.conversationId,
    mailboxIdentityId: event.mailboxIdentityId,
    change: event.change,
    isImplicit: event.isImplicit,
    actor: summaryOf(event.actorUserId),
    claimedByUserId: event.claimedByUserId,
    claimedBy: summaryOf(event.claimedByUserId),
    previousClaimant: summaryOf(event.previousClaimantUserId),
    claimedAt: event.claimedByUserId ? event.changedAt.toISOString() : null,
    changedAt: event.changedAt.toISOString(),
  };
}

/**
 * The instant a claim write stamped with `now()`, read from its `RETURNING`
 * row (`raw` of the UPDATE's result), so the response and the event carry
 * the database's own time. Throws when the row carries no value: that means
 * the `.returning()` column and this read have drifted apart, and a silent
 * stand-in from the server clock would hide it.
 */
export function returnedTimestamp(raw: unknown, column: string): Date {
  const firstRow: unknown = Array.isArray(raw) ? raw[0] : undefined;
  const value =
    firstRow && typeof firstRow === 'object'
      ? (firstRow as Record<string, unknown>)[column]
      : undefined;
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    return new Date(value);
  }
  throw new Error(`The claim write returned no ${column} value`);
}

/**
 * The one claim write, shared by `ConversationsService.claim` and the claim
 * a reply takes (`MessagingCoreService.persistSentMessage`, Task 23). A
 * single conditional UPDATE guarded on `claimed_by_user_id IS NULL`, so of
 * two racing claims exactly one matches the row, and a claim never moves a
 * colleague's. It clears the latest release and take-over, so the row keeps
 * the latest change only. `conversations` is the caller's repository: the
 * reply passes its transaction's repository, so the claim commits or rolls
 * back with the message.
 *
 * Returns the database's claim time when the UPDATE matched the row, and
 * null when someone already held the thread.
 */
export async function claimUnclaimedConversation(
  conversations: Repository<Conversation>,
  conversationId: string,
  claimantUserId: string,
): Promise<Date | null> {
  const result = await conversations
    .createQueryBuilder()
    .update()
    .set({
      claimedByUserId: claimantUserId,
      claimedAt: () => 'now()',
      claimReleasedByUserId: null,
      claimReleasedAt: null,
      claimTakenOverFromUserId: null,
    })
    .where('id = :conversationId', { conversationId })
    .andWhere('claimed_by_user_id IS NULL')
    .returning(['claimedAt'])
    .execute();
  return result.affected === 1
    ? returnedTimestamp(result.raw, 'claimed_at')
    : null;
}
