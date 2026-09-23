import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Moves every existing listing-enquiry thread into its listing's business
 * mailbox, splitting it at the enquiry so private history stays personal.
 *
 * HANDOVER. This migration rewrites member-visible history: it moves
 * messages between conversations, changes who a customer sees as the author
 * of the owner's replies, and gives every active co-manager a seat in the
 * business thread. It is unapplied. Run it on a copy of production data and
 * read the logged counts before applying it anywhere real.
 *
 * RUNNING. Nothing gates this migration to a manual step:
 * `ensureDatabaseSchema` applies pending migrations at boot, and the
 * pre-deploy command applies them while the previous version still serves
 * traffic. The whole rewrite is one transaction, and it holds row locks on
 * every moved or re-attributed message, every moved conversation, every
 * owner seat and every repointed enquiry until it commits. A send into a
 * moved thread waits on those locks, so apply it in a quiet window and time
 * it on the production copy first.
 *
 * THE DECISION: SPLIT AT THE ENQUIRY. `MessageRequestsService.deliverEnquiry`
 * reused the existing one-to-one thread by `pair_key`, so an enquiry can sit
 * at the bottom of a thread that already held private conversation between
 * the customer and the owner. Everything before the enquiry stays in that
 * personal DM, between the customer and the owner, and the business thread
 * starts at the enquiry. Co-managers therefore see only the business part,
 * and a later handover of the listing, or the customer blocking the
 * business, leaves the private history untouched because it never left the
 * personal DM. Live code never converts a DM into a business thread
 * (`getOrCreateIdentityConversation` always keys a fresh identity pair), so
 * this migration is the only place the split applies.
 *
 * TWO SHAPES. Per moving conversation the split instant is its enquiry
 * anchor (see THE ANCHOR). A conversation holding any message, of any kind,
 * created before the split instant has pre-enquiry history.
 *  - REKEYED (no pre-enquiry history): the whole thread already is the
 *    business part, so it becomes the business thread in place.
 *  - SPLIT (pre-enquiry history): a new business conversation is created,
 *    and every message at or after the split instant moves into it. The
 *    personal DM keeps everything before the split, its seats and its
 *    `pair_key`.
 *
 * THE ANCHOR. `listing_enquiries` carries no message id: it links to its
 * message only through `conversation_id`, `sender_id` and `created_at`.
 * `ListingEnquiriesService.send` posts the message FIRST and writes the
 * enquiry row after it, and the body always opens with the prefix
 * `ListingEnquiriesService.composeEnquiryBody` writes. So each enquiry's
 * message is the enquirer's `user` message in that conversation NEAREST the
 * enquiry row: the latest one created at or before the row and at most one
 * minute before it, whatever its body. That nearest message is taken first
 * and only then tested, so an older message can never stand in for it. It
 * counts as the enquiry message when it carries that prefix, or when it was
 * edited (`edited_at` set) or deleted (`deleted_at` set, the tombstone whose
 * body the evidence-hold purge later blanks): those are exactly the ways an
 * enquiry message loses its prefix. Only when no such message exists does
 * the anchor fall back to the enquiry row's own `created_at`, which lies a
 * few milliseconds AFTER where its message was. A later split keeps more in
 * the personal DM, so the fallback errs private, and with no enquiry bubble
 * left there is nothing it could strand. A conversation's split instant is
 * the earliest of its enquiries' anchors, so every enquiry of a moved
 * thread sits at or after it. The log counts the moved threads whose split
 * instant came from a fallback (`fallbackAnchorCount`).
 *
 * WHAT MOVES, in order, each statement set-based over one eligible set held
 * in a temporary table for the length of this migration's transaction:
 *  1. Mint the listing identity for every listing an enquiry references,
 *     `ON CONFLICT DO NOTHING` against `UQ_identities_listing`, as the
 *     backfill in `1821200000000-AddIdentities.ts` does. Listings created
 *     after that backfill only get one lazily.
 *  2. Build the eligible set and log the counts (see COUNTS).
 *  3. Record every moved thread in `enquiry_mailbox_moves` (see
 *     BOOKKEEPING).
 *  4. SPLIT: create the business conversation, and seat the customer (their
 *     profile identity) and the owner (the listing identity) on it.
 *  5. REKEYED: the owner's seat takes the listing identity. Nothing else on
 *     it moves, and its own `cleared_at` stays: it is a personal clear.
 *  6. Seat every other active co-manager on the business thread with the
 *     listing identity, NULL `cleared_at`, and the owner's watermarks (see
 *     WATERMARKS).
 *  7. SPLIT: every message created at or after the split instant moves to
 *     the business conversation, its pins follow it, and the thread's
 *     `listing_enquiries` rows point at the business conversation.
 *  8. The owner's messages in the business thread, all created at or after
 *     the split instant, take the listing identity as
 *     `sender_identity_id`. Owner messages that stay personal keep their
 *     profile identity.
 *  9. Post one system message recording the move at the top of the
 *     business thread (see THE SYSTEM MESSAGE).
 * 10. REKEYED: `pair_key` becomes the business pair key, and the thread's
 *     reply-gate columns are set as a business thread needs them (see THE
 *     REPLY GATE).
 * The business pair key is the sorted pair of the customer's profile
 * identity and the listing identity, ordered `COLLATE "C"` to match
 * `MessagingCoreService.identityPairKey`, as `1821240000000` explains.
 *
 * THE NEW CONVERSATION (split threads only), column by column as
 * `src/messaging/entities/conversation.entity.ts` declares them:
 *  - `id`: minted in the eligible set with `uuid_generate_v4()`, the
 *    column's own default, so every later statement can address it.
 *  - `is_official`: false. `official_member_id`: NULL. `kind`: `direct`.
 *  - `title`, `avatar_url`, `created_by`, `description`, `invite_token`,
 *    `dissolved_at`: NULL, as on every direct thread.
 *  - `pair_key`: the business pair key.
 *  - `initiator_user_id`: the customer, as `deliverEnquiryToIdentity`
 *    seeds it on a live enquiry thread.
 *  - `opened_at`: the owner's first message at or after the split instant,
 *    which is the reply that opens a live enquiry thread
 *    (`MessagesService.sendMessage`). NULL when the owner has not written
 *    since the enquiry, so the thread waits for the business exactly as a
 *    live one does.
 *  - `opened_at_before_block`: NULL. No person block stands between the
 *    customer and the owner (`customer_owner_blocked` skips those threads),
 *    so there is nothing to restore.
 *  - `claimed_by_user_id`, `claimed_at`: NULL, so the thread starts
 *    unclaimed. The three claim-release columns of `1821280000000` are left
 *    to their NULL default and never named, because on a fresh database
 *    they do not exist yet when this runs.
 *  - `created_at`: the move note's instant, so the thread begins with its
 *    note.
 * `conversations` carries no last-message or updated-at column: the inbox
 * derives both from `messages`, so moving the rows recomputes them for both
 * threads. The personal DM sinks to its last private message.
 *
 * THE NEW SEATS (split threads only), column by column as
 * `src/messaging/entities/conversation-participant.entity.ts` declares them:
 *  - `identity_id`: the customer's profile identity for the customer, the
 *    listing identity for the owner and for every co-manager.
 *  - `role`: the `member` default. `removed_by`, `removed_at`, `left_at`:
 *    NULL.
 *  - `last_read_at`, `last_read_instant`, `delivered_at`: copied from the
 *    customer's and the owner's old seats. Co-managers follow WATERMARKS.
 *  - `muted`, `mute_mode`, `muted_until`: copied for the customer and the
 *    owner. Co-managers start unmuted, as a hire seats them.
 *  - `pinned_at`, `favorited_at`, `archived_at`, `marked_unread_at`,
 *    `draft`: stay on the personal DM, and every new seat starts with none.
 *    They record how the person files that DM, and a draft typed there
 *    belongs to that conversation.
 *  - `cleared_at`: the customer and the owner copy their old `cleared_at`
 *    only when it is at or after the split instant, because only then does
 *    it cover part of the business thread. An earlier clear covers only
 *    messages that stay personal, so the new seat takes NULL. Co-managers
 *    take NULL: the business thread starts at the enquiry, so there is no
 *    earlier history to hide from them.
 *  - Every co-manager active when this runs, on a split or a rekeyed
 *    thread, sees the whole business part from the enquiry onward,
 *    including messages sent before they accepted the co-manager invite.
 *    A live hire is floored at its accept instant, so this is wider than
 *    what a hire gets today. It is accepted: no pre-enquiry DM history
 *    reaches a co-manager, and flooring each one at their `accepted_at`
 *    would need the per-seat history floor column, which `1821500000000`
 *    adds and which runs after this migration on a fresh database.
 *  - The per-seat history floor that `1821500000000` adds is never named.
 *    On a fresh database that column does not exist yet when this runs, and
 *    in production every seat inserted here takes its NULL default, which
 *    is right: this migration writes no floor.
 *
 * OTHER CONVERSATION-KEYED STATE, checked against every entity that holds a
 * conversation id:
 *  - `messages.conversation_id`: moved for split threads (step 7).
 *    `UQ_messages_conversation_client_id` cannot collide: the moved rows
 *    were unique within the personal DM, and the business conversation
 *    starts empty.
 *  - `conversation_pinned_messages`: a pin follows its message (step 7).
 *  - `listing_enquiries.conversation_id` (no FK): every enquiry of a split
 *    thread points at the business conversation (step 7), since its anchor
 *    sits at or after the split instant.
 *  - `message_reactions`, `message_stars`, `message_hides`: keyed on
 *    `message_id` only, so they follow their message with no write.
 *  - `group_invites`: groups only, and no group moves.
 *  - Message-request state lives on the conversation itself
 *    (`initiator_user_id`, `opened_at`). THE REPLY GATE covers the
 *    business thread of both shapes and the personal DM a split leaves.
 *  - `blocks` (person to person) and `identity_blocks` (person to business)
 *    are keyed on people and identities alone, so they apply to the
 *    business thread unchanged.
 *  - Claims: split threads start unclaimed. Rekeyed threads were personal,
 *    so they hold no claim either.
 *  - Notifications keep `conversationId` inside their JSON payload. A
 *    message notification from before the move still deep-links to the
 *    personal DM, where a moved message is no longer found. They are left
 *    as they are, because rewriting stored notification payloads buys a
 *    stale deep link at the cost of a scan of every notification.
 *  - Reports address messages, members and identities, and group
 *    conversations only, so none point at a direct thread.
 *
 * THE REPLY GATE. A business thread ignores personal connection
 * (`MessagesService.sendMessage`): only `opened_at`, or the initiator's
 * counterpart replying, lets it be written. A rekeyed thread between
 * connected members can hold owner replies and still carry a NULL
 * `opened_at`, since a connected pair never needed opening, and a thread
 * with no initiator would refuse the business itself. So a rekeyed thread
 * takes the customer as `initiator_user_id` and keeps its `opened_at`, or
 * takes the owner's first reply at or after the split instant when it had
 * none. Both previous values are recorded for `down()`.
 *
 * A split thread's personal DM keeps its `initiator_user_id` and
 * `opened_at` as they are, even when `opened_at` was stamped by an owner
 * reply that now lives in the business thread. The pair could already
 * write to each other personally before the move, and the split leaves
 * that as it was.
 *
 * STAFF is exactly `IdentitiesService.staffUserIds` for a listing identity
 * (`listingStaff` in `src/identities/identities.service.ts`): the listing's
 * current `owner_id` plus every `listing_co_managers` row with
 * `status = 'active'`. Invited, declined, revoked and left rows grant
 * nothing. A deleted listing takes its enquiries with it through
 * `ON DELETE CASCADE`, so none reach this migration.
 *
 * SKIPPED. A thread that cannot move safely stays personal, which is the
 * status quo. Each reason below is counted and logged:
 *  - `already_business_thread`: some seat already carries a non-profile
 *    identity (or one that no longer resolves). This is the idempotency
 *    guard, so a re-run moves nothing.
 *  - `several_listings` (case 1): `pair_key` is unique per pair, so a
 *    customer who enquired about two listings of the same owner has one
 *    thread referenced by both, and it cannot belong to two mailboxes.
 *  - `not_one_to_one`: the conversation is missing, is a group or official
 *    thread, has no `pair_key`, does not hold exactly two seats, holds
 *    enquiries from more than one enquirer, or the enquirer holds no seat.
 *  - `customer_blocked_business`: the enquirer holds an `identity_blocks`
 *    row on the listing identity. The mailbox read rule removes every seat,
 *    the customer's and the owner's included, from a thread whose customer
 *    blocked the business, so moving it would make the enquiry and every
 *    reply to it unreachable for both of them.
 *  - `customer_owner_blocked`: a person block stands between the enquirer
 *    and the listing's owner, in either direction. The personal thread is
 *    hidden from both of them today. Once moved, the owner's seat becomes a
 *    staff seat, which the mailbox read rule removes alone, so the customer
 *    would regain the business part, and every co-manager could reach a
 *    person the owner blocked, or who blocked the owner.
 *  - `customer_is_staff` (case 5): the enquirer now owns or co-manages the
 *    listing.
 *  - `owner_without_seat` (case 2): the listing has no owner, or it changed
 *    hands, so the thread is between the customer and a former owner.
 *  - `mailbox_thread_exists` (case 3): a thread between the customer and
 *    the listing identity already exists, because new-enquiry routing may
 *    ship before this runs. Writing the business pair key again would
 *    violate `UQ_conversations_pair_key`, and merging threads is out of
 *    scope.
 *  - `nothing_to_move`: no message sits at or after the split instant, so
 *    the business thread would hold only a note claiming a move that moved
 *    nothing. The thread stays personal, and the customer's next enquiry
 *    opens a business thread the ordinary way.
 * Two moved threads can never compute the same business pair key: that
 * would need the same customer and listing, whose current owner shares
 * exactly one personal thread with that customer.
 *
 * A CO-MANAGER ALREADY SEATED (case 6) is impossible here. A one-to-one
 * thread seats the customer and one other person, that person must be the
 * current owner to pass `owner_without_seat`, and a co-manager who is the
 * customer is skipped as `customer_is_staff`. The insert still carries
 * `ON CONFLICT DO NOTHING` so an impossible row cannot fail the migration.
 *
 * BLOCKS (case 8). A person block between the customer and a co-manager
 * does not stop the seat. The mailbox read rule leaves only that staff
 * seat dark while the block holds, and a later unblock restores access,
 * the same as for a seat the application creates. A customer's block of
 * the listing identity, and a person block between the customer and the
 * owner, are skip reasons (see SKIPPED).
 *
 * REPLY QUOTES. `reply_to_id` is left intact. A moved reply that quotes a
 * message which stayed in the personal DM keeps pointing at it, and the
 * same-conversation guard in the reply-quote loader
 * (`MessagingCoreService`) renders that quote as unavailable, so the
 * business thread never shows pre-enquiry text. The guard must be deployed
 * before this runs. Leaving the column intact is what keeps `down()` a full
 * reversal. The log counts these replies (`crossSplitReplyCount`).
 *
 * THE SYSTEM MESSAGE uses the mechanism group pills use
 * (`GroupsService.insertSystemMessage`): `kind = 'system'`, a structured
 * `system_event`, and an English fallback `body`. The event type is
 * `moved_to_business_mailbox`, with `value` the listing identity id and
 * `actorId` the owner whose thread moved. The text names no actor, because
 * the migration itself made the move: the body is exactly
 * `SYSTEM_EVENT_FALLBACK.moved_to_business_mailbox`. `sender_id` is NULL,
 * because no human typed this note and because every unread formula counts
 * only `m.sender_id != :userId`, which a NULL sender never satisfies: the
 * note is unread for nobody. `sender_identity_id` is the listing identity,
 * and `CHK_messages_sender_identity` allows it with a NULL sender.
 *
 * The note goes in the business thread only, stamped one microsecond below
 * that thread's first message (`nothing_to_move` guarantees there is one),
 * so it reads first and never bumps the thread in
 * anybody's inbox. The personal DM gets no note: the frontend renders the
 * event as "This conversation moved to {business}'s mailbox", which would
 * be false in a DM that stays personal and keeps its history.
 *
 * WATERMARKS. A co-manager's seat copies the owner seat's `delivered_at`,
 * `last_read_at` and `last_read_instant` as they stand at migration time.
 * A customer reads the business's delivered and read state as the latest
 * across the staff seats that share read receipts
 * (`ConversationsService.listConversations`, `otherLastReadAt`), so a copy
 * of the owner's values adds nothing beyond what the owner already shows
 * the customer, and a co-manager starts with exactly what the business has
 * not yet read as unread. The one exception is an owner who turned read
 * receipts off (`member_preferences.share_read_receipts`, absent meaning
 * on): their read watermarks are withheld from the customer today, and a
 * co-manager who shares receipts would otherwise publish them, so for that
 * owner the co-manager seats start with no read watermark. Delivery is not
 * gated by that preference, so `delivered_at` is copied either way.
 *
 * COUNTS, printed with `console.log` as one JSON array, one row per outcome
 * (`moved` or a skip reason) with its `threadCount`. The other counters
 * describe moved threads only, so a skipped row reports zero for each:
 *  - `rekeyedThreadCount` and `splitThreadCount`: the two shapes.
 *  - `movedMessageCount`: messages that change conversation (split only).
 *  - `crossSplitReplyCount`: moved replies quoting a message that stays
 *    personal (see REPLY QUOTES).
 *  - `fallbackAnchorCount`: threads whose split instant, the earliest
 *    anchor, fell back to an enquiry row's own timestamp (see THE ANCHOR).
 *
 * BOOKKEEPING. `enquiry_mailbox_moves` is a small table this migration
 * creates and `down()` drops: one row per moved thread, keyed on the
 * personal conversation, naming the business conversation (the same id for
 * a rekeyed thread), the shape, the listing identity, the owner and the
 * profile identity their seat held, the customer, the split instant, and
 * the previous `pair_key`, `initiator_user_id` and `opened_at`. `down()`
 * reads it to find split pairs, which nothing else records durably. A
 * marker inside the note's `system_event` would travel with a
 * member-visible row, and could not carry the previous reply-gate values;
 * members never see this table. It has no entity on purpose, since no
 * application code reads it, and TypeORM's schema diff never proposes
 * dropping a table it has no entity for. It holds member ids with no FK, so
 * once the move is confirmed permanent a follow-up migration drops it, and
 * from then on this `down()` is no longer available.
 *
 * TRANSACTION. One ordinary per-migration transaction, so the whole rewrite
 * commits or none of it does. No DDL beyond the temporary table and the
 * bookkeeping table, and no `CONCURRENTLY`.
 *
 * DOWN reverses both shapes for every recorded thread whose owner seat on
 * the business thread is still the recorded owner, active, speaking for
 * the listing:
 *  - Both: the move note is deleted, and every owner message in the
 *    personal conversation sent as the listing returns to the owner's
 *    profile identity.
 *  - SPLIT: the customer's and owner's personal seats take the later of
 *    each watermark from their business seats. Every message in the
 *    business conversation (later ones included) moves back into the
 *    personal DM, with its pins, and every enquiry pointing at the business
 *    conversation points at the DM again. The DM takes the business
 *    thread's `opened_at` when it had none of its own and the customer is
 *    its initiator, since the business replies it now holds are what would
 *    have opened it. A person block between the customer and the owner, in
 *    either direction, leaves the DM unopened, as a live block voids
 *    `opened_at`. The business seats and the business conversation are
 *    deleted. A `cleared_at` written on a
 *    business seat after the move does not carry back, because in the DM it
 *    would also hide the private history.
 *  - REKEYED: the owner's seat returns to the owner's profile identity,
 *    every other seat on the listing identity is removed (co-managers
 *    seated later by `IdentityMailboxSyncService` included), the claim is
 *    cleared, `pair_key` returns to its recorded value, and
 *    `initiator_user_id` and `opened_at` return to theirs unless live code
 *    changed them since.
 * The listing identities from step 1 stay, since the application mints them
 * anyway. A thread whose owner seat changed (handover, departure), whose
 * conversation no longer exists, or (rekeyed only) whose restored
 * `pair_key` a newer personal thread already holds, stays in the mailbox
 * and is counted. Replies a co-manager sent as the business stay attributed
 * to the business after their seat is removed; their number is logged.
 * `down()` names only the claim columns that exist when it runs on a fresh
 * database, so the three claim-release columns keep whatever they hold.
 */
export class MigrateEnquiryThreadsToListingMailboxes1821260000000 implements MigrationInterface {
  name = 'MigrateEnquiryThreadsToListingMailboxes1821260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: every referenced listing gets its identity row.
    await queryRunner.query(`
      INSERT INTO "identities" ("kind", "listing_id")
      SELECT 'listing', "listing"."id"
      FROM "listings" AS "listing"
      WHERE "listing"."id" IN (SELECT "listing_id" FROM "listing_enquiries")
      ON CONFLICT ("listing_id") WHERE "listing_id" IS NOT NULL DO NOTHING
    `);

    // Step 2: the eligible set. `skip_reason` is NULL for a thread that moves.
    await queryRunner.query(`
      CREATE TEMP TABLE "enquiry_thread_moves" AS
      WITH "enquiry_anchors" AS (
        SELECT
          "enquiry"."conversation_id",
          "enquiry"."listing_id",
          "enquiry"."sender_id",
          CASE WHEN "nearest_message"."is_enquiry_message"
            THEN "nearest_message"."created_at"
            ELSE "enquiry"."created_at"
          END AS "anchor_instant",
          COALESCE("nearest_message"."is_enquiry_message", false) AS "is_exact_anchor"
        FROM "listing_enquiries" AS "enquiry"
        LEFT JOIN LATERAL (
          SELECT
            "message"."created_at",
            (
              "message"."body" LIKE 'Enquiry about your QueerPulse listing "%'
              OR "message"."edited_at" IS NOT NULL
              OR "message"."deleted_at" IS NOT NULL
            ) AS "is_enquiry_message"
          FROM "messages" AS "message"
          WHERE "message"."conversation_id" = "enquiry"."conversation_id"
            AND "message"."sender_id" = "enquiry"."sender_id"
            AND "message"."kind" = 'user'
            AND "message"."created_at" <= "enquiry"."created_at"
            AND "message"."created_at" >= "enquiry"."created_at" - interval '1 minute'
          ORDER BY "message"."created_at" DESC
          LIMIT 1
        ) AS "nearest_message" ON true
      ),
      "enquiry_threads" AS (
        SELECT
          "conversation_id",
          COUNT(DISTINCT "listing_id") AS "listing_count",
          COUNT(DISTINCT "sender_id") AS "sender_count",
          MIN("listing_id"::text)::uuid AS "listing_id",
          MIN("sender_id"::text)::uuid AS "customer_user_id",
          MIN("anchor_instant") AS "split_instant",
          -- The exactness of the anchor that sets the split instant. On a tie
          -- a fallback sorts first, so the count errs toward reporting one.
          (ARRAY_AGG("is_exact_anchor" ORDER BY "anchor_instant", "is_exact_anchor"))[1]
            AS "is_exact_anchor"
        FROM "enquiry_anchors"
        GROUP BY "conversation_id"
      ),
      "seat_facts" AS (
        SELECT
          "seat"."conversation_id",
          COUNT(*) AS "seat_count",
          BOOL_OR("seat_identity"."kind" IS DISTINCT FROM 'profile') AS "has_business_seat"
        FROM "conversation_participants" AS "seat"
        LEFT JOIN "identities" AS "seat_identity" ON "seat_identity"."id" = "seat"."identity_id"
        WHERE "seat"."conversation_id" IN (SELECT "conversation_id" FROM "listing_enquiries")
        GROUP BY "seat"."conversation_id"
      ),
      "thread_facts" AS (
        SELECT
          "thread"."conversation_id",
          "thread"."listing_id",
          "thread"."customer_user_id",
          "thread"."split_instant",
          "thread"."is_exact_anchor",
          "thread"."listing_count",
          "thread"."sender_count",
          "conversation"."id" IS NOT NULL AS "has_conversation",
          "conversation"."kind" AS "conversation_kind",
          "conversation"."is_official",
          "conversation"."pair_key",
          "conversation"."initiator_user_id",
          "conversation"."opened_at",
          COALESCE("seat_facts"."seat_count", 0) AS "seat_count",
          COALESCE("seat_facts"."has_business_seat", false) AS "has_business_seat",
          "listing"."owner_id" AS "owner_user_id",
          "listing_identity"."id" AS "listing_identity_id",
          "customer_seat"."identity_id" AS "customer_identity_id",
          "owner_seat"."id" IS NOT NULL AS "has_owner_seat",
          "owner_seat"."identity_id" AS "owner_identity_id",
          EXISTS (
            SELECT 1 FROM "identity_blocks" AS "business_block"
            WHERE "business_block"."blocker_user_id" = "thread"."customer_user_id"
              AND "business_block"."identity_id" = "listing_identity"."id"
          ) AS "has_customer_blocked_business",
          EXISTS (
            SELECT 1 FROM "blocks" AS "owner_block"
            WHERE ("owner_block"."blocker_id" = "thread"."customer_user_id"
                AND "owner_block"."blocked_id" = "listing"."owner_id")
              OR ("owner_block"."blocked_id" = "thread"."customer_user_id"
                AND "owner_block"."blocker_id" = "listing"."owner_id")
          ) AS "has_customer_owner_block",
          EXISTS (
            SELECT 1 FROM "listing_co_managers" AS "co_manager"
            WHERE "co_manager"."listing_id" = "thread"."listing_id"
              AND "co_manager"."user_id" = "thread"."customer_user_id"
              AND "co_manager"."status" = 'active'
          ) AS "is_customer_co_manager"
        FROM "enquiry_threads" AS "thread"
        LEFT JOIN "conversations" AS "conversation" ON "conversation"."id" = "thread"."conversation_id"
        LEFT JOIN "seat_facts" ON "seat_facts"."conversation_id" = "thread"."conversation_id"
        LEFT JOIN "listings" AS "listing" ON "listing"."id" = "thread"."listing_id"
        LEFT JOIN "identities" AS "listing_identity"
          ON "listing_identity"."listing_id" = "thread"."listing_id"
        LEFT JOIN "conversation_participants" AS "customer_seat"
          ON "customer_seat"."conversation_id" = "thread"."conversation_id"
          AND "customer_seat"."user_id" = "thread"."customer_user_id"
        LEFT JOIN "conversation_participants" AS "owner_seat"
          ON "owner_seat"."conversation_id" = "thread"."conversation_id"
          AND "owner_seat"."user_id" = "listing"."owner_id"
      ),
      "keyed_threads" AS (
        SELECT
          "thread_facts".*,
          CASE
            WHEN "customer_identity_id"::text COLLATE "C" < "listing_identity_id"::text COLLATE "C"
              THEN "customer_identity_id"::text || ':' || "listing_identity_id"::text
            ELSE "listing_identity_id"::text || ':' || "customer_identity_id"::text
          END AS "new_pair_key",
          "thread_history".*
        FROM "thread_facts"
        -- Every message counts here, whatever its kind: anything before the
        -- split instant is pre-enquiry history.
        CROSS JOIN LATERAL (
          SELECT
            COALESCE(BOOL_OR("message"."created_at" < "thread_facts"."split_instant"), false)
              AS "has_pre_enquiry_history",
            COUNT(*) FILTER (WHERE "message"."created_at" >= "thread_facts"."split_instant")
              AS "business_message_count",
            MIN("message"."created_at") FILTER (WHERE "message"."created_at" >= "thread_facts"."split_instant")
              AS "first_business_message_at",
            MIN("message"."created_at") FILTER (
              WHERE "message"."created_at" >= "thread_facts"."split_instant"
                AND "message"."sender_id" = "thread_facts"."owner_user_id"
            ) AS "first_owner_reply_at"
          FROM "messages" AS "message"
          WHERE "message"."conversation_id" = "thread_facts"."conversation_id"
        ) AS "thread_history"
      ),
      "classified_threads" AS (
        SELECT
          "keyed_threads".*,
          CASE
            WHEN "has_business_seat" THEN 'already_business_thread'
            WHEN "listing_count" > 1 THEN 'several_listings'
            WHEN NOT "has_conversation"
              OR "conversation_kind" <> 'direct'
              OR "is_official"
              OR "pair_key" IS NULL
              OR "seat_count" <> 2
              OR "sender_count" <> 1
              OR "customer_identity_id" IS NULL
              OR "listing_identity_id" IS NULL
              THEN 'not_one_to_one'
            WHEN "has_customer_blocked_business" THEN 'customer_blocked_business'
            WHEN "has_customer_owner_block" THEN 'customer_owner_blocked'
            WHEN "customer_user_id" = "owner_user_id" OR "is_customer_co_manager"
              THEN 'customer_is_staff'
            WHEN "owner_user_id" IS NULL OR NOT "has_owner_seat"
              THEN 'owner_without_seat'
            WHEN EXISTS (
              SELECT 1 FROM "conversations" AS "existing_thread"
              WHERE "existing_thread"."pair_key" = "keyed_threads"."new_pair_key"
                AND "existing_thread"."id" <> "keyed_threads"."conversation_id"
            ) THEN 'mailbox_thread_exists'
            WHEN "business_message_count" = 0 THEN 'nothing_to_move'
            ELSE NULL
          END AS "skip_reason"
        FROM "keyed_threads"
      )
      SELECT
        "classified".*,
        "skip_reason" IS NULL AND "has_pre_enquiry_history" AS "is_split",
        CASE WHEN "skip_reason" IS NULL AND "has_pre_enquiry_history"
          THEN uuid_generate_v4()
          ELSE "conversation_id"
        END AS "business_conversation_id",
        "first_business_message_at" - interval '1 microsecond' AS "note_created_at",
        CASE WHEN "has_pre_enquiry_history"
          THEN "first_owner_reply_at"
          ELSE COALESCE("opened_at", "first_owner_reply_at")
        END AS "business_opened_at",
        CASE WHEN "skip_reason" IS NULL AND "has_pre_enquiry_history"
          THEN (
            SELECT COUNT(*)
            FROM "messages" AS "reply"
            JOIN "messages" AS "quoted_parent" ON "quoted_parent"."id" = "reply"."reply_to_id"
            WHERE "reply"."conversation_id" = "classified"."conversation_id"
              AND "reply"."created_at" >= "classified"."split_instant"
              AND "quoted_parent"."conversation_id" = "classified"."conversation_id"
              AND "quoted_parent"."created_at" < "classified"."split_instant"
          )
          ELSE 0
        END AS "cross_split_reply_count"
      FROM "classified_threads" AS "classified"
    `);
    // The planner otherwise guesses the temporary table's size.
    await queryRunner.query(`ANALYZE "enquiry_thread_moves"`);

    // Every count past `threadCount` describes threads this run moves, so a
    // skipped row adds nothing to them.
    const outcomeRows: unknown = await queryRunner.query(`
      SELECT
        COALESCE("skip_reason", 'moved') AS "outcome",
        COUNT(*) AS "threadCount",
        COUNT(*) FILTER (WHERE "skip_reason" IS NULL AND NOT "is_split") AS "rekeyedThreadCount",
        COUNT(*) FILTER (WHERE "skip_reason" IS NULL AND "is_split") AS "splitThreadCount",
        COALESCE(SUM("business_message_count") FILTER (
          WHERE "skip_reason" IS NULL AND "is_split"
        ), 0) AS "movedMessageCount",
        COALESCE(SUM("cross_split_reply_count") FILTER (
          WHERE "skip_reason" IS NULL AND "is_split"
        ), 0) AS "crossSplitReplyCount",
        COUNT(*) FILTER (WHERE "skip_reason" IS NULL AND NOT "is_exact_anchor") AS "fallbackAnchorCount"
      FROM "enquiry_thread_moves"
      GROUP BY COALESCE("skip_reason", 'moved')
      ORDER BY COALESCE("skip_reason", 'moved')
    `);
    // Deliberately loud: the maintainer reads this to see which enquiry
    // threads stayed personal and why, how many moved in each shape, how
    // many messages changed conversation, how many moved replies quote a
    // message that stays personal (see REPLY QUOTES), and how many anchors
    // fell back to the enquiry row's own timestamp.
    console.log(
      `[MigrateEnquiryThreadsToListingMailboxes] up ${JSON.stringify(outcomeRows)}`,
    );

    // Step 3: the durable record `down()` reads (see BOOKKEEPING).
    await queryRunner.query(`
      CREATE TABLE "enquiry_mailbox_moves" (
        "source_conversation_id" uuid NOT NULL,
        "business_conversation_id" uuid NOT NULL,
        "is_split" boolean NOT NULL,
        "listing_identity_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "owner_identity_id" uuid NOT NULL,
        "customer_user_id" uuid NOT NULL,
        "split_instant" TIMESTAMP WITH TIME ZONE NOT NULL,
        "previous_pair_key" character varying NOT NULL,
        "previous_initiator_user_id" uuid,
        "previous_opened_at" TIMESTAMP WITH TIME ZONE,
        "business_opened_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_enquiry_mailbox_moves" PRIMARY KEY ("source_conversation_id")
      )
    `);
    await queryRunner.query(`
      INSERT INTO "enquiry_mailbox_moves" (
        "source_conversation_id", "business_conversation_id", "is_split",
        "listing_identity_id", "owner_user_id", "owner_identity_id",
        "customer_user_id", "split_instant", "previous_pair_key",
        "previous_initiator_user_id", "previous_opened_at", "business_opened_at"
      )
      SELECT
        "move"."conversation_id", "move"."business_conversation_id", "move"."is_split",
        "move"."listing_identity_id", "move"."owner_user_id", "move"."owner_identity_id",
        "move"."customer_user_id", "move"."split_instant", "move"."pair_key",
        "move"."initiator_user_id", "move"."opened_at", "move"."business_opened_at"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
    `);

    // Step 4a: the business conversation of every split thread (see THE NEW
    // CONVERSATION for each column).
    await queryRunner.query(`
      INSERT INTO "conversations" ("id", "is_official", "kind", "pair_key", "initiator_user_id", "opened_at", "created_at")
      SELECT
        "move"."business_conversation_id",
        false,
        'direct',
        "move"."new_pair_key",
        "move"."customer_user_id",
        "move"."business_opened_at",
        "move"."note_created_at"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND "move"."is_split"
    `);

    // Step 4b: the customer and the owner on the business conversation (see
    // THE NEW SEATS for each column).
    await queryRunner.query(`
      INSERT INTO "conversation_participants" ("conversation_id", "user_id", "identity_id", "cleared_at", "last_read_at", "last_read_instant", "delivered_at", "muted", "mute_mode", "muted_until")
      SELECT
        "move"."business_conversation_id",
        "old_seat"."user_id",
        CASE WHEN "old_seat"."user_id" = "move"."owner_user_id"
          THEN "move"."listing_identity_id"
          ELSE "move"."customer_identity_id"
        END,
        CASE WHEN "old_seat"."cleared_at" >= "move"."split_instant" THEN "old_seat"."cleared_at" END,
        "old_seat"."last_read_at",
        "old_seat"."last_read_instant",
        "old_seat"."delivered_at",
        "old_seat"."muted",
        "old_seat"."mute_mode",
        "old_seat"."muted_until"
      FROM "enquiry_thread_moves" AS "move"
      JOIN "conversation_participants" AS "old_seat"
        ON "old_seat"."conversation_id" = "move"."conversation_id"
        AND "old_seat"."user_id" IN ("move"."customer_user_id", "move"."owner_user_id")
      WHERE "move"."skip_reason" IS NULL
        AND "move"."is_split"
    `);

    // Step 5: a rekeyed thread's owner seat speaks for the listing. It keeps
    // its history and its own cleared_at.
    await queryRunner.query(`
      UPDATE "conversation_participants" AS "owner_seat"
      SET "identity_id" = "move"."listing_identity_id"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND NOT "move"."is_split"
        AND "owner_seat"."conversation_id" = "move"."conversation_id"
        AND "owner_seat"."user_id" = "move"."owner_user_id"
    `);

    // Step 6: every other active co-manager on the business thread, with no
    // floor, carrying the owner's own watermarks from the owner's seat in the
    // original conversation (see WATERMARKS).
    await queryRunner.query(`
      INSERT INTO "conversation_participants" ("conversation_id", "user_id", "identity_id", "cleared_at", "last_read_at", "last_read_instant", "delivered_at")
      SELECT
        "move"."business_conversation_id",
        "co_manager"."user_id",
        "move"."listing_identity_id",
        NULL::timestamptz,
        CASE WHEN "owner_privacy"."is_owner_sharing_read_receipts" THEN "owner_seat"."last_read_at" END,
        CASE WHEN "owner_privacy"."is_owner_sharing_read_receipts" THEN "owner_seat"."last_read_instant" END,
        "owner_seat"."delivered_at"
      FROM "enquiry_thread_moves" AS "move"
      JOIN "conversation_participants" AS "owner_seat"
        ON "owner_seat"."conversation_id" = "move"."conversation_id"
        AND "owner_seat"."user_id" = "move"."owner_user_id"
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          (SELECT "preferences"."share_read_receipts" FROM "member_preferences" AS "preferences"
           WHERE "preferences"."user_id" = "move"."owner_user_id"),
          true
        ) AS "is_owner_sharing_read_receipts"
      ) AS "owner_privacy"
      JOIN "listing_co_managers" AS "co_manager"
        ON "co_manager"."listing_id" = "move"."listing_id"
        AND "co_manager"."status" = 'active'
        AND "co_manager"."user_id" <> "move"."owner_user_id"
        AND "co_manager"."user_id" <> "move"."customer_user_id"
      WHERE "move"."skip_reason" IS NULL
      ON CONFLICT ("conversation_id", "user_id") DO NOTHING
    `);

    // Step 7a: a split thread's business part moves, from the split on.
    await queryRunner.query(`
      UPDATE "messages" AS "message"
      SET "conversation_id" = "move"."business_conversation_id"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND "move"."is_split"
        AND "message"."conversation_id" = "move"."conversation_id"
        AND "message"."created_at" >= "move"."split_instant"
    `);

    // Step 7b: a pin follows its message.
    await queryRunner.query(`
      UPDATE "conversation_pinned_messages" AS "pin"
      SET "conversation_id" = "move"."business_conversation_id"
      FROM "enquiry_thread_moves" AS "move", "messages" AS "message"
      WHERE "move"."skip_reason" IS NULL
        AND "move"."is_split"
        AND "pin"."conversation_id" = "move"."conversation_id"
        AND "message"."id" = "pin"."message_id"
        AND "message"."conversation_id" = "move"."business_conversation_id"
    `);

    // Step 7c: every enquiry of a split thread anchors at or after the split
    // instant, so each one now lives in the business conversation.
    await queryRunner.query(`
      UPDATE "listing_enquiries" AS "enquiry"
      SET "conversation_id" = "move"."business_conversation_id"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND "move"."is_split"
        AND "enquiry"."conversation_id" = "move"."conversation_id"
    `);

    // Step 8: the owner's replies in the business thread are the business's.
    await queryRunner.query(`
      UPDATE "messages" AS "message"
      SET "sender_identity_id" = "move"."listing_identity_id"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND "message"."conversation_id" = "move"."business_conversation_id"
        AND "message"."sender_id" = "move"."owner_user_id"
        AND "message"."created_at" >= "move"."split_instant"
    `);

    // Step 9: one note per moved thread, at the top of the business thread.
    await queryRunner.query(`
      INSERT INTO "messages" ("conversation_id", "sender_id", "sender_identity_id", "body", "kind", "system_event", "created_at")
      SELECT
        "move"."business_conversation_id",
        NULL,
        "move"."listing_identity_id",
        'This conversation moved to the business mailbox',
        'system',
        jsonb_build_object(
          'type', 'moved_to_business_mailbox',
          'actorId', "move"."owner_user_id"::text,
          'value', "move"."listing_identity_id"::text
        ),
        "move"."note_created_at"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
    `);

    // Step 10: a rekeyed thread is now keyed on the customer and the listing,
    // with the reply gate a business thread reads (see THE REPLY GATE).
    await queryRunner.query(`
      UPDATE "conversations" AS "conversation"
      SET
        "pair_key" = "move"."new_pair_key",
        "initiator_user_id" = "move"."customer_user_id",
        "opened_at" = "move"."business_opened_at"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND NOT "move"."is_split"
        AND "conversation"."id" = "move"."conversation_id"
    `);

    await queryRunner.query(`DROP TABLE "enquiry_thread_moves"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Every recorded thread, with the reason it cannot be reverted, if any.
    await queryRunner.query(`
      CREATE TEMP TABLE "enquiry_thread_reverts" AS
      SELECT
        "move".*,
        CASE
          WHEN "business_conversation"."id" IS NULL
            OR "source_conversation"."id" IS NULL
            THEN 'conversation_missing'
          WHEN NOT EXISTS (
            SELECT 1 FROM "conversation_participants" AS "owner_seat"
            WHERE "owner_seat"."conversation_id" = "move"."business_conversation_id"
              AND "owner_seat"."user_id" = "move"."owner_user_id"
              AND "owner_seat"."identity_id" = "move"."listing_identity_id"
              AND "owner_seat"."left_at" IS NULL
          ) THEN 'owner_seat_changed'
          WHEN NOT "move"."is_split" AND EXISTS (
            SELECT 1 FROM "conversations" AS "existing_thread"
            WHERE "existing_thread"."pair_key" = "move"."previous_pair_key"
              AND "existing_thread"."id" <> "move"."source_conversation_id"
          ) THEN 'personal_thread_exists'
          ELSE NULL
        END AS "skip_reason",
        (
          SELECT COUNT(*)
          FROM "messages" AS "staff_reply"
          WHERE "staff_reply"."conversation_id" = "move"."business_conversation_id"
            AND "staff_reply"."sender_identity_id" = "move"."listing_identity_id"
            AND "staff_reply"."sender_id" <> "move"."owner_user_id"
        ) AS "staff_reply_count",
        CASE WHEN "move"."is_split"
          THEN (
            SELECT COUNT(*)
            FROM "messages" AS "business_message"
            WHERE "business_message"."conversation_id" = "move"."business_conversation_id"
              AND "business_message"."kind" <> 'system'
          )
          ELSE 0
        END AS "returned_message_count"
      FROM "enquiry_mailbox_moves" AS "move"
      LEFT JOIN "conversations" AS "business_conversation"
        ON "business_conversation"."id" = "move"."business_conversation_id"
      LEFT JOIN "conversations" AS "source_conversation"
        ON "source_conversation"."id" = "move"."source_conversation_id"
    `);

    const outcomeRows: unknown = await queryRunner.query(`
      SELECT
        COALESCE("skip_reason", 'reverted') AS "outcome",
        COUNT(*) AS "threadCount",
        COUNT(*) FILTER (WHERE "is_split") AS "splitThreadCount",
        COALESCE(SUM("staff_reply_count"), 0) AS "staffReplyCount",
        COALESCE(SUM("returned_message_count"), 0) AS "returnedMessageCount"
      FROM "enquiry_thread_reverts"
      GROUP BY COALESCE("skip_reason", 'reverted')
      ORDER BY COALESCE("skip_reason", 'reverted')
    `);
    console.log(
      `[MigrateEnquiryThreadsToListingMailboxes] down ${JSON.stringify(outcomeRows)}`,
    );

    // Reverses step 9, before any message moves back, so no note ever lands
    // in a personal DM.
    await queryRunner.query(`
      DELETE FROM "messages" AS "note"
      USING "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "note"."conversation_id" = "revert"."business_conversation_id"
        AND "note"."kind" = 'system'
        AND "note"."system_event" ->> 'type' = 'moved_to_business_mailbox'
        AND "note"."system_event" ->> 'value' = "revert"."listing_identity_id"::text
    `);

    // Split: the customer and the owner keep what they read in the business
    // thread. GREATEST skips a NULL, so a watermark only moves forward.
    await queryRunner.query(`
      UPDATE "conversation_participants" AS "personal_seat"
      SET
        "delivered_at" = GREATEST("personal_seat"."delivered_at", "business_seat"."delivered_at"),
        "last_read_at" = GREATEST("personal_seat"."last_read_at", "business_seat"."last_read_at"),
        "last_read_instant" = GREATEST("personal_seat"."last_read_instant", "business_seat"."last_read_instant")
      FROM "enquiry_thread_reverts" AS "revert", "conversation_participants" AS "business_seat"
      WHERE "revert"."skip_reason" IS NULL
        AND "revert"."is_split"
        AND "personal_seat"."conversation_id" = "revert"."source_conversation_id"
        AND "business_seat"."conversation_id" = "revert"."business_conversation_id"
        AND "business_seat"."user_id" = "personal_seat"."user_id"
    `);

    // Reverses step 7a, with every message sent into the business thread since.
    await queryRunner.query(`
      UPDATE "messages" AS "message"
      SET "conversation_id" = "revert"."source_conversation_id"
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "revert"."is_split"
        AND "message"."conversation_id" = "revert"."business_conversation_id"
    `);

    // Reverses step 7b.
    await queryRunner.query(`
      UPDATE "conversation_pinned_messages" AS "pin"
      SET "conversation_id" = "revert"."source_conversation_id"
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "revert"."is_split"
        AND "pin"."conversation_id" = "revert"."business_conversation_id"
    `);

    // Reverses step 7c, with any enquiry delivered into the business thread
    // since.
    await queryRunner.query(`
      UPDATE "listing_enquiries" AS "enquiry"
      SET "conversation_id" = "revert"."source_conversation_id"
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "revert"."is_split"
        AND "enquiry"."conversation_id" = "revert"."business_conversation_id"
    `);

    // Split: a DM left unopened takes the business thread's opened_at when
    // the customer is its initiator, so the business replies it now holds
    // leave the customer able to write, as they would have in the DM. Read
    // before the business conversation is deleted below. A person block
    // between the customer and the owner, in either direction, keeps the DM
    // unopened, so after an unblock the thread still needs the fresh reply
    // that reopens a blocked pair (PRD-340).
    await queryRunner.query(`
      UPDATE "conversations" AS "personal_conversation"
      SET "opened_at" = "business_conversation"."opened_at"
      FROM "enquiry_thread_reverts" AS "revert", "conversations" AS "business_conversation"
      WHERE "revert"."skip_reason" IS NULL
        AND "revert"."is_split"
        AND "personal_conversation"."id" = "revert"."source_conversation_id"
        AND "business_conversation"."id" = "revert"."business_conversation_id"
        AND "personal_conversation"."opened_at" IS NULL
        AND "personal_conversation"."initiator_user_id" = "revert"."customer_user_id"
        AND "business_conversation"."opened_at" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "blocks" AS "pair_block"
          WHERE ("pair_block"."blocker_id" = "revert"."customer_user_id"
              AND "pair_block"."blocked_id" = "revert"."owner_user_id")
            OR ("pair_block"."blocked_id" = "revert"."customer_user_id"
              AND "pair_block"."blocker_id" = "revert"."owner_user_id")
        )
    `);

    // Reverses step 4: the business seats, then the emptied business
    // conversation.
    await queryRunner.query(`
      DELETE FROM "conversation_participants" AS "business_seat"
      USING "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "revert"."is_split"
        AND "business_seat"."conversation_id" = "revert"."business_conversation_id"
    `);
    await queryRunner.query(`
      DELETE FROM "conversations" AS "business_conversation"
      USING "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "revert"."is_split"
        AND "business_conversation"."id" = "revert"."business_conversation_id"
    `);

    // Reverses step 5.
    await queryRunner.query(`
      UPDATE "conversation_participants" AS "owner_seat"
      SET "identity_id" = "revert"."owner_identity_id"
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND NOT "revert"."is_split"
        AND "owner_seat"."conversation_id" = "revert"."source_conversation_id"
        AND "owner_seat"."user_id" = "revert"."owner_user_id"
    `);

    // Reverses step 6 on a rekeyed thread, with any co-manager seated since.
    // A split thread's co-manager seats went with its business conversation.
    await queryRunner.query(`
      DELETE FROM "conversation_participants" AS "staff_seat"
      USING "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND NOT "revert"."is_split"
        AND "staff_seat"."conversation_id" = "revert"."source_conversation_id"
        AND "staff_seat"."identity_id" = "revert"."listing_identity_id"
        AND "staff_seat"."user_id" <> "revert"."owner_user_id"
    `);

    // Reverses step 8. Every message is back in the personal conversation by
    // now, and owner messages that stayed personal never took the listing
    // identity, so every owner message on it here is one to hand back.
    await queryRunner.query(`
      UPDATE "messages" AS "message"
      SET "sender_identity_id" = "revert"."owner_identity_id"
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "message"."conversation_id" = "revert"."source_conversation_id"
        AND "message"."sender_id" = "revert"."owner_user_id"
        AND "message"."sender_identity_id" = "revert"."listing_identity_id"
    `);

    // Reverses step 10, and drops a claim that only means something in a
    // mailbox. The reply gate returns to its recorded values unless live
    // code moved it since.
    await queryRunner.query(`
      UPDATE "conversations" AS "conversation"
      SET
        "pair_key" = "revert"."previous_pair_key",
        "claimed_by_user_id" = NULL,
        "claimed_at" = NULL,
        "initiator_user_id" = CASE
          WHEN "conversation"."initiator_user_id" IS NOT DISTINCT FROM "revert"."customer_user_id"
            THEN "revert"."previous_initiator_user_id"
          ELSE "conversation"."initiator_user_id"
        END,
        "opened_at" = CASE
          WHEN "conversation"."opened_at" IS NOT DISTINCT FROM "revert"."business_opened_at"
            THEN "revert"."previous_opened_at"
          ELSE "conversation"."opened_at"
        END
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND NOT "revert"."is_split"
        AND "conversation"."id" = "revert"."source_conversation_id"
    `);

    await queryRunner.query(`DROP TABLE "enquiry_thread_reverts"`);
    await queryRunner.query(`DROP TABLE "enquiry_mailbox_moves"`);
  }
}
