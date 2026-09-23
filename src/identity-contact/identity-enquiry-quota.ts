/**
 * Task 18: the counted caps on cold enquiries, the same shape
 * `ListingEnquiriesService` gives directory listings: a few a day to one
 * mailbox, and ONE daily ceiling shared by every kind of cold enquiry
 * (fix round 1): directory listings, personas and companies together, so a
 * member cannot double their day by spreading it across kinds.
 *
 * WHAT COUNTS toward the shared ceiling: every `listing_enquiries` row the
 * member wrote in the window, and every persona or company cold message. A
 * persona or company enquiry keeps no row of its own, so those are counted
 * from the messages: a message the member sent, in a thread they started
 * with a persona or company mailbox, before that mailbox first answered
 * (`opened_at`). Once the business has replied, the thread is an ordinary
 * conversation and its messages are not cold contact any more. A message
 * deleted afterwards still counts, so deleting cannot reset the cap. A
 * directory enquiry is counted from its row only: its thread is a listing
 * mailbox, which the message read leaves out, so nothing counts twice.
 *
 * TWO BOUNDED READS, each at most one row more than the ceiling, newest
 * first, merged. When the merged list holds fewer rows than the ceiling
 * both reads were complete; when it holds at least that many the ceiling
 * binds on its own, and its release time is the ceiling-th newest row of the
 * merge, which lies inside both slices. Truncation can only hide a
 * per-mailbox cap that is already masked.
 *
 * The message read starts from the member's own seats, joins each thread's
 * messages through `IDX_messages_conversation_id_created_at`, and keeps the
 * threads the member initiated (`IDX_conversations_initiator_user_id`,
 * migration 1821270000000) with a persona or company. Every alias is
 * lowercase and quoted at every reference.
 */
export const MAX_ENQUIRIES_PER_MAILBOX_PER_DAY = 3;
export const MAX_COLD_ENQUIRIES_PER_DAY = 20;
export const IDENTITY_ENQUIRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const IDENTITY_ENQUIRY_QUOTA_ROW_LIMIT = MAX_COLD_ENQUIRIES_PER_DAY + 1;

/** `$1` the member's user id, `$2` the start of the window, `$3` the row
 *  limit. */
export const COLD_IDENTITY_ENQUIRY_MESSAGES_SQL = `
SELECT "cold_message"."conversation_id" AS "conversationId",
       "cold_message"."created_at" AS "createdAt"
FROM "conversation_participants" "customer_seat"
INNER JOIN "identities" "customer_identity"
  ON "customer_identity"."id" = "customer_seat"."identity_id"
INNER JOIN "conversations" "enquiry_conversation"
  ON "enquiry_conversation"."id" = "customer_seat"."conversation_id"
INNER JOIN "messages" "cold_message"
  ON "cold_message"."conversation_id" = "customer_seat"."conversation_id"
WHERE "customer_seat"."user_id" = $1
  AND "customer_identity"."kind" = 'profile'
  AND "enquiry_conversation"."initiator_user_id" = $1
  AND "cold_message"."sender_id" = $1
  AND "cold_message"."created_at" > $2
  AND (
    "enquiry_conversation"."opened_at" IS NULL
    OR "cold_message"."created_at" < "enquiry_conversation"."opened_at"
  )
  AND EXISTS (
    SELECT 1 FROM "conversation_participants" "mailbox_seat"
    INNER JOIN "identities" "mailbox_identity"
      ON "mailbox_identity"."id" = "mailbox_seat"."identity_id"
    WHERE "mailbox_seat"."conversation_id" = "customer_seat"."conversation_id"
      AND "mailbox_identity"."kind" IN ('subprofile', 'company')
  )
ORDER BY "cold_message"."created_at" DESC
LIMIT $3`;

/** Fix round 1: the member's `listing_enquiries` rows in the window, for the
 *  shared ceiling. Same parameters as the message read. Backed by
 *  `IDX_listing_enquiries_sender_id_created_at`. */
export const COLD_LISTING_ENQUIRY_ROWS_SQL = `
SELECT "listing_enquiry"."listing_id" AS "listingId",
       "listing_enquiry"."created_at" AS "createdAt"
FROM "listing_enquiries" "listing_enquiry"
WHERE "listing_enquiry"."sender_id" = $1
  AND "listing_enquiry"."created_at" > $2
ORDER BY "listing_enquiry"."created_at" DESC
LIMIT $3`;

/** One counted message, as the message read returns it. */
export interface ColdIdentityEnquiryRow {
  conversationId: string;
  createdAt: Date;
}

/** One counted cold enquiry of any kind. `mailboxKey` names what it was
 *  sent to (`coldEnquiryMailboxKey`), so the per-mailbox cap can pick its
 *  own rows out of the merged list. */
export interface ColdEnquiryRow {
  mailboxKey: string;
  createdAt: Date;
}

/** The `mailboxKey` of a persona or company thread, or of a listing. */
export function coldEnquiryMailboxKey(
  target: { conversationId: string } | { listingId: string },
): string {
  return 'conversationId' in target
    ? `conversation:${target.conversationId}`
    : `listing:${target.listingId}`;
}

/** Anything that runs raw SQL: a TypeORM repository or `DataSource`. */
export interface RawQueryRunner {
  query(sql: string, parameters: unknown[]): Promise<unknown>;
}

/** Fix round 1: the persona and company half of the count, the message
 *  read alone, for `ListingEnquiriesService`, which reads its own rows. */
export async function loadColdIdentityEnquiryMessages(
  runner: RawQueryRunner,
  userId: string,
  since: Date,
): Promise<ColdIdentityEnquiryRow[]> {
  const rows = (await runner.query(COLD_IDENTITY_ENQUIRY_MESSAGES_SQL, [
    userId,
    since,
    IDENTITY_ENQUIRY_QUOTA_ROW_LIMIT,
  ])) as ColdIdentityEnquiryRow[];
  return rows.map((row) => ({
    conversationId: row.conversationId,
    createdAt: new Date(row.createdAt),
  }));
}

/**
 * Fix round 1: every cold enquiry the member sent in the window, of every
 * kind, newest first: the two bounded reads, merged.
 */
export async function loadColdEnquiries(
  runner: RawQueryRunner,
  userId: string,
): Promise<ColdEnquiryRow[]> {
  const since = new Date(Date.now() - IDENTITY_ENQUIRY_WINDOW_MS);
  const [messageRows, listingRows] = await Promise.all([
    loadColdIdentityEnquiryMessages(runner, userId, since),
    runner.query(COLD_LISTING_ENQUIRY_ROWS_SQL, [
      userId,
      since,
      IDENTITY_ENQUIRY_QUOTA_ROW_LIMIT,
    ]) as Promise<Array<{ listingId: string; createdAt: Date }>>,
  ]);
  return [
    ...messageRows.map((row) => ({
      mailboxKey: coldEnquiryMailboxKey({ conversationId: row.conversationId }),
      createdAt: row.createdAt,
    })),
    ...listingRows.map((row) => ({
      mailboxKey: coldEnquiryMailboxKey({ listingId: row.listingId }),
      createdAt: new Date(row.createdAt),
    })),
  ].sort(
    (first, second) => second.createdAt.getTime() - first.createdAt.getTime(),
  );
}

export type IdentityEnquiryLimitReason =
  'wrote_to_this_mailbox_today' | 'wrote_across_mailboxes_today';

/** Where the member stands against both caps. `getContact` reports it and
 *  the send enforces it, from one evaluation, so the two cannot disagree. */
export type IdentityEnquiryQuotaState =
  | { hasReachedLimit: false }
  | {
      hasReachedLimit: true;
      reason: IdentityEnquiryLimitReason;
      clearsAt: Date;
    };

/**
 * Both caps off the merged newest-first list. `mailboxKey` is the key of the
 * mailbox being written to, or null when there is nothing to count against
 * it yet (a persona or company the member has no thread with). When both
 * caps bite, the per-mailbox one is named and the later release time is
 * given, exactly as the listing quota does.
 */
export function evaluateIdentityEnquiryQuota(
  newestFirstRows: ReadonlyArray<ColdEnquiryRow>,
  mailboxKey: string | null,
): IdentityEnquiryQuotaState {
  const toThisMailbox = mailboxKey
    ? newestFirstRows.filter((row) => row.mailboxKey === mailboxKey)
    : [];
  const isMailboxCapped =
    toThisMailbox.length >= MAX_ENQUIRIES_PER_MAILBOX_PER_DAY;
  const isDirectoryCapped =
    newestFirstRows.length >= MAX_COLD_ENQUIRIES_PER_DAY;
  if (!isMailboxCapped && !isDirectoryCapped) {
    return { hasReachedLimit: false };
  }
  const releaseTimes: number[] = [];
  if (isMailboxCapped) {
    releaseTimes.push(
      releaseTime(toThisMailbox, MAX_ENQUIRIES_PER_MAILBOX_PER_DAY),
    );
  }
  if (isDirectoryCapped) {
    releaseTimes.push(releaseTime(newestFirstRows, MAX_COLD_ENQUIRIES_PER_DAY));
  }
  return {
    hasReachedLimit: true,
    reason: isMailboxCapped
      ? 'wrote_to_this_mailbox_today'
      : 'wrote_across_mailboxes_today',
    clearsAt: new Date(Math.max(...releaseTimes)),
  };
}

/** The sentence behind each 429, beside the reason codes so a client reading
 *  the code and one reading the 429 are told the same thing. */
export function identityEnquiryLimitMessage(
  reason: IdentityEnquiryLimitReason,
): string {
  return reason === 'wrote_to_this_mailbox_today'
    ? 'You have already written here today. Give them a chance to reply first.'
    : 'You have sent a lot of enquiries today. Try again tomorrow.';
}

/** When a cap of `limit` lifts: the moment the limit-th newest counted row
 *  ages out of the rolling day. A missing row errs a full day late. */
function releaseTime(
  newestFirstRows: ReadonlyArray<{ createdAt: Date }>,
  limit: number,
): number {
  const limitingRow = newestFirstRows[limit - 1];
  if (!limitingRow) {
    return Date.now() + IDENTITY_ENQUIRY_WINDOW_MS;
  }
  return new Date(limitingRow.createdAt).getTime() + IDENTITY_ENQUIRY_WINDOW_MS;
}
