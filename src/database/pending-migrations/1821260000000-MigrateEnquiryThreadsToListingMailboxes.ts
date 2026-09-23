import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Moves every existing listing-enquiry thread into its listing's business
 * mailbox, and protects the private history some of those threads hold.
 *
 * HANDOVER. This migration rewrites member-visible history: it changes who
 * a customer sees as the author of the owner's replies, and it gives every
 * active co-manager a seat in the thread. It is unapplied. Run it on a copy
 * of production data and read the logged counts before applying it anywhere
 * real.
 *
 * RUNNING. Nothing gates this migration to a manual step:
 * `ensureDatabaseSchema` applies pending migrations at boot, and the
 * pre-deploy command applies them while the previous version still serves
 * traffic. The whole rewrite is one transaction, and it holds row locks on
 * every re-attributed message, every moved conversation and every owner
 * seat until it commits. A review run took about 10 seconds for 20,000
 * enquiry threads over 4 million messages. A send into a moved thread waits
 * on those locks, so apply it in a quiet window and time it on the
 * production copy first.
 *
 * REPLY QUOTES. Read paths render a reply's quoted parent, and serve its
 * attachment, without checking the reader's own `cleared_at`, so a
 * post-floor reply quoting a pre-floor message would show that message to
 * co-managers. The application fix lives outside this file and must land
 * before this runs. The log counts moved threads holding such a reply, so
 * the maintainer sees the exposure on the production copy.
 *
 * THE PRIVACY PROBLEM. `MessageRequestsService.deliverEnquiry` reuses the
 * existing one-to-one thread by `pair_key`, so an enquiry can sit at the
 * bottom of a thread that already held private conversation between the
 * customer and the owner, and `listing_enquiries.conversation_id` points at
 * that shared thread. The owner keeps their own seat and its full history.
 * Every other active co-manager is seated with `cleared_at` set just below
 * the first enquiry message, which is the per-person floor the conversation
 * list, the thread and the media gallery already apply on read
 * (`created_at > cleared_at`). Staff see the thread from the enquiry forward.
 *
 * THE FLOOR. `listing_enquiries` carries no message id: it links to its
 * message only through `conversation_id`, `sender_id` and `created_at`.
 * `ListingEnquiriesService.send` posts the message FIRST and writes the
 * enquiry row after it, and the body always opens with the prefix
 * `ListingEnquiriesService.composeEnquiryBody` writes. So each enquiry's
 * message is the enquirer's `user` message in that conversation NEAREST the
 * enquiry row: the latest one created at or before the row and at most one
 * minute before it, whatever its body. It counts as the enquiry message
 * only when it carries that prefix, so an older enquiry message can never
 * stand in for a real one that was edited. When it does not match (the
 * body was edited, or blanked by the evidence-hold purge), the floor falls
 * back to the enquiry row's own `created_at`, which lies a few
 * milliseconds AFTER its message: a later floor hides more, so the fallback
 * errs toward privacy at the cost of staff missing that one enquiry bubble.
 * The number of fallbacks is logged. A conversation's floor is the earliest
 * of its enquiries' floors.
 *
 * PRECISION. Postgres keeps microseconds, and the driver reads every
 * timestamp into a JavaScript `Date`, which keeps milliseconds. The read
 * paths compare a message against `cleared_at` in three shapes: in SQL
 * (`created_at > cleared_at`), in JavaScript (hidden when
 * `createdAt <= clearedAt`, both truncated), and in SQL against a bound
 * `clearedAt` that the driver already truncated (`getMessages`, the media
 * gallery, the export). So every co-manager floor is a whole millisecond,
 * and it is at least:
 *  - the millisecond just below the floor instant,
 *  - the latest message created before the floor instant, rounded UP to
 *    the next whole millisecond, and
 *  - the owner's own `cleared_at`, rounded up the same way, so a thread
 *    the owner cleared for himself stays cleared for his co-managers.
 * A move note that an earlier `down()` left in place is skipped when finding
 * the latest earlier message and the newest message, so a run after
 * `down()` computes the same floor and note time as the first run.
 * With a whole-millisecond floor the three shapes agree on every message:
 * everything before the floor instant sits at or below it, and the enquiry
 * message sits in a later millisecond. When the latest earlier message
 * shares the enquiry message's millisecond, no whole millisecond separates
 * them, so the floor covers the enquiry message too and co-managers miss
 * that one bubble. That errs private, and the log counts it as
 * `enquiryCoveredCount`. An owner who cleared the thread after the enquiry
 * covers it the same way, by design; the log counts those threads apart,
 * as `ownerClearCoveredCount`.
 *
 * WHAT MOVES, in order, each statement set-based over one eligible set held
 * in a temporary table for the length of this migration's transaction:
 *  1. Mint the listing identity for every listing an enquiry references,
 *     `ON CONFLICT DO NOTHING` against `UQ_identities_listing`, as the
 *     backfill in `1821200000000-AddIdentities.ts` does. Listings created
 *     after that backfill only get one lazily.
 *  2. Build the eligible set and log how many threads stay personal, per
 *     reason (see SKIPPED below).
 *  3. The owner's seat takes the listing identity. Nothing else on it moves.
 *  4. Seat every other active co-manager with the listing identity, the
 *     `cleared_at` floor, and a copy of the owner's watermarks (see
 *     WATERMARKS). The owner's and customer's seats are untouched.
 *  5. The owner's messages sent at or after the floor take the listing
 *     identity as `sender_identity_id`. Earlier owner messages keep their
 *     profile identity.
 *  6. Post one system message recording the move, stamped after the latest
 *     earlier message and just below the floor instant (see THE SYSTEM
 *     MESSAGE).
 *  7. `pair_key` becomes the sorted pair of the customer's profile identity
 *     and the listing identity, ordered `COLLATE "C"` to match
 *     `MessagingCoreService.identityPairKey`, as `1821240000000` explains.
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
 *    blocked the business, so moving it would make the whole personal
 *    thread, private history included, unreachable for both of them.
 *  - `customer_owner_blocked`: a person block stands between the enquirer
 *    and the listing's owner, in either direction. The personal thread is
 *    hidden from both of them today. Once moved, the owner's seat becomes a
 *    staff seat, which the mailbox read rule removes alone, so the customer
 *    would regain the whole thread, private history included, and every
 *    co-manager could reach a person the owner blocked, or who blocked the
 *    owner.
 *  - `customer_is_staff` (case 5): the enquirer now owns or co-manages the
 *    listing.
 *  - `owner_without_seat` (case 2): the listing has no owner, or it changed
 *    hands, so the thread is between the customer and a former owner.
 *  - `mailbox_thread_exists` (case 3): a thread between the customer and
 *    the listing identity already exists, because new-enquiry routing may
 *    ship before this runs. Recomputing `pair_key` would violate
 *    `UQ_conversations_pair_key`, and merging threads is out of scope.
 * Two moved threads can never compute the same new `pair_key`: that would
 * need the same customer and listing, whose current owner shares exactly
 * one personal thread with that customer.
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
 * THE SYSTEM MESSAGE uses the mechanism group pills use
 * (`GroupsService.insertSystemMessage`): `kind = 'system'`, a structured
 * `system_event`, and an English fallback `body`. The event type is
 * `moved_to_business_mailbox`, with `value` the listing identity id and
 * `actorId` the owner whose thread moved, which `down()` reads. The text
 * names no actor, because the migration itself made the move: the body is
 * exactly `SYSTEM_EVENT_FALLBACK.moved_to_business_mailbox`.
 * `sender_id` is NULL, because no human typed this note and because
 * every unread formula counts only `m.sender_id != :userId`, which a NULL
 * sender never satisfies: the note is unread for nobody, the customer
 * included, whatever their read watermark. `sender_identity_id` is the
 * listing identity, and `CHK_messages_sender_identity` allows it with a
 * NULL sender. `down()` finds the threads it moved through this message. A
 * re-run after `down()` finds the note already present and posts no second
 * one.
 *
 * The note is stamped one millisecond above the co-manager floor, so it is
 * visible to co-managers on every shape, and it is pulled lower when that
 * would reach the floor instant or the thread's newest message: it sits
 * at the latest one microsecond below the floor instant and one
 * microsecond below the newest message. Threads order by
 * `(created_at, id)`, so the note never bumps a thread in anybody's inbox
 * and is never a thread's newest message. On an exact floor the floor
 * instant is the enquiry message itself, so the note precedes it. On a
 * fallback floor the floor instant is the enquiry row, a few milliseconds
 * after the enquiry message, so the note can land just after that message.
 * Where the room above the floor is too small, it stays in place and falls
 * at or below the floor, where co-managers do not see it, or at or below
 * the latest earlier message. The log counts both.
 *
 * WATERMARKS. A co-manager's seat copies the owner seat's `delivered_at`,
 * `last_read_at` and `last_read_instant` as they stand at migration time.
 * A customer reads the business's delivered and read state as the latest
 * across the staff seats that share read receipts
 * (`ConversationsService.listConversations`, `otherLastReadAt`), so a copy
 * of the owner's values adds nothing beyond what the owner already shows
 * the customer, and a co-manager starts with exactly what the business has
 * not yet read, after their floor, as unread. The one exception is an owner
 * who turned read receipts off (`member_preferences.share_read_receipts`,
 * absent meaning on): their read watermarks are withheld from the customer
 * today, and a co-manager who shares receipts would otherwise publish
 * them, so for that owner the co-manager seats start with no read
 * watermark. Delivery is not gated by that preference, so `delivered_at` is
 * copied either way.
 *
 * TRANSACTION. One ordinary per-migration transaction, so the whole rewrite
 * commits or none of it does. No DDL beyond the temporary table, and no
 * `CONCURRENTLY`.
 *
 * DOWN reverses steps 3, 4, 5 and 7 for every thread this migration moved
 * whose owner seat still carries the listing identity: the owner's seat and
 * every owner message sent as the listing return to the owner's profile
 * identity, every other seat on the listing identity is removed (co-managers
 * seated later by `IdentityMailboxSyncService` included), the claim is
 * cleared, and `pair_key` returns to the pair of profile identities. The
 * system message from step 6 is left in place, because deleting
 * member-visible history on a rollback is worse than an orphan note. The
 * listing identities from step 1 stay, since the application mints them
 * anyway. A thread whose restored `pair_key` is already taken by a newer
 * personal thread between the same two people stays in the mailbox and is
 * counted. Replies a co-manager sent as the business stay attributed to the
 * business after their seat is removed; their number is logged.
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
      WITH "enquiry_floors" AS (
        SELECT
          "enquiry"."conversation_id",
          "enquiry"."listing_id",
          "enquiry"."sender_id",
          CASE WHEN "nearest_message"."has_enquiry_prefix"
            THEN "nearest_message"."created_at"
            ELSE "enquiry"."created_at"
          END AS "floor_instant",
          COALESCE("nearest_message"."has_enquiry_prefix", false) AS "is_exact_floor"
        FROM "listing_enquiries" AS "enquiry"
        LEFT JOIN LATERAL (
          SELECT
            "message"."created_at",
            "message"."body" LIKE 'Enquiry about your QueerPulse listing "%' AS "has_enquiry_prefix"
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
          MIN("floor_instant") AS "floor_instant",
          BOOL_AND("is_exact_floor") AS "is_exact_floor"
        FROM "enquiry_floors"
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
          "thread"."floor_instant",
          "thread"."is_exact_floor",
          "thread"."listing_count",
          "thread"."sender_count",
          "conversation"."id" IS NOT NULL AS "has_conversation",
          "conversation"."kind" AS "conversation_kind",
          "conversation"."is_official",
          "conversation"."pair_key",
          COALESCE("seat_facts"."seat_count", 0) AS "seat_count",
          COALESCE("seat_facts"."has_business_seat", false) AS "has_business_seat",
          "listing"."owner_id" AS "owner_user_id",
          "listing_identity"."id" AS "listing_identity_id",
          "customer_seat"."identity_id" AS "customer_identity_id",
          "owner_seat"."id" IS NOT NULL AS "has_owner_seat",
          "owner_seat"."cleared_at" AS "owner_cleared_at",
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
          -- A move note that an earlier down() left in place is this
          -- migration's own output, so it never shapes a floor or a note.
          (
            SELECT MAX("message"."created_at") FROM "messages" AS "message"
            WHERE "message"."conversation_id" = "thread_facts"."conversation_id"
              AND "message"."created_at" < "thread_facts"."floor_instant"
              AND NOT ("message"."kind" = 'system'
                AND "message"."system_event" ->> 'type' = 'moved_to_business_mailbox')
          ) AS "latest_before_floor",
          (
            SELECT MAX("message"."created_at") FROM "messages" AS "message"
            WHERE "message"."conversation_id" = "thread_facts"."conversation_id"
              AND NOT ("message"."kind" = 'system'
                AND "message"."system_event" ->> 'type' = 'moved_to_business_mailbox')
          ) AS "latest_message"
        FROM "thread_facts"
      ),
      "floored_threads" AS (
        -- Whole milliseconds only (see PRECISION). Rounding up to a whole
        -- millisecond is truncating after adding 999 microseconds.
        SELECT
          "keyed_threads".*,
          GREATEST(
            date_trunc('milliseconds', "floor_instant" - interval '1 microsecond') - interval '1 millisecond',
            date_trunc('milliseconds', "latest_before_floor" + interval '999 microseconds'),
            date_trunc('milliseconds', "owner_cleared_at" + interval '999 microseconds')
          ) AS "staff_floor_base"
        FROM "keyed_threads"
      ),
      "covered_threads" AS (
        SELECT
          "floored_threads".*,
          date_trunc('milliseconds', "floor_instant") <= "staff_floor_base" AS "is_enquiry_covered",
          COALESCE(
            date_trunc('milliseconds', "floor_instant")
              <= date_trunc('milliseconds', "owner_cleared_at" + interval '999 microseconds'),
            false
          ) AS "is_enquiry_covered_by_owner_clear",
          CASE
            WHEN date_trunc('milliseconds', "floor_instant") <= "staff_floor_base"
              THEN GREATEST(
                "staff_floor_base",
                date_trunc('milliseconds', "floor_instant" + interval '999 microseconds')
              )
            ELSE "staff_floor_base"
          END AS "staff_cleared_at"
        FROM "floored_threads"
      ),
      "noted_threads" AS (
        SELECT
          "covered_threads".*,
          LEAST(
            "staff_cleared_at" + interval '1 millisecond',
            "floor_instant" - interval '1 microsecond',
            "latest_message" - interval '1 microsecond'
          ) AS "note_created_at"
        FROM "covered_threads"
      )
      SELECT
        "noted_threads".*,
        "note_created_at" >= "staff_cleared_at" + interval '1 millisecond' AS "is_note_visible_to_staff",
        "latest_before_floor" IS NULL OR "note_created_at" > "latest_before_floor"
          AS "is_note_after_earlier_messages",
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
            WHERE "existing_thread"."pair_key" = "noted_threads"."new_pair_key"
              AND "existing_thread"."id" <> "noted_threads"."conversation_id"
          ) THEN 'mailbox_thread_exists'
          ELSE NULL
        END AS "skip_reason"
      FROM "noted_threads"
    `);
    // The planner otherwise guesses the temporary table's size.
    await queryRunner.query(`ANALYZE "enquiry_thread_moves"`);

    // Every count past `threadCount` describes threads this run moves, so a
    // skipped row adds nothing to them.
    const outcomeRows: unknown = await queryRunner.query(`
      SELECT
        COALESCE("skip_reason", 'moved') AS "outcome",
        COUNT(*) AS "threadCount",
        COUNT(*) FILTER (WHERE "skip_reason" IS NULL AND NOT "is_exact_floor") AS "fallbackFloorCount",
        COUNT(*) FILTER (
          WHERE "skip_reason" IS NULL
            AND "is_enquiry_covered"
            AND NOT "is_enquiry_covered_by_owner_clear"
        ) AS "enquiryCoveredCount",
        COUNT(*) FILTER (
          WHERE "skip_reason" IS NULL AND "is_enquiry_covered_by_owner_clear"
        ) AS "ownerClearCoveredCount",
        COUNT(*) FILTER (WHERE "skip_reason" IS NULL AND NOT "is_note_visible_to_staff") AS "noteBelowStaffFloorCount",
        COUNT(*) FILTER (
          WHERE "skip_reason" IS NULL AND NOT "is_note_after_earlier_messages"
        ) AS "noteAboveEarlierMessageCount",
        COUNT(*) FILTER (
          WHERE "skip_reason" IS NULL AND EXISTS (
            SELECT 1
            FROM "messages" AS "reply"
            JOIN "messages" AS "quoted_parent" ON "quoted_parent"."id" = "reply"."reply_to_id"
            WHERE "reply"."conversation_id" = "enquiry_thread_moves"."conversation_id"
              AND "reply"."created_at" > "enquiry_thread_moves"."staff_cleared_at"
              AND "quoted_parent"."created_at" <= "enquiry_thread_moves"."staff_cleared_at"
          )
        ) AS "preFloorQuoteThreadCount"
      FROM "enquiry_thread_moves"
      GROUP BY COALESCE("skip_reason", 'moved')
      ORDER BY COALESCE("skip_reason", 'moved')
    `);
    // Deliberately loud: the maintainer reads this to see which enquiry
    // threads stayed personal, how many floors fell back to the enquiry
    // row's own timestamp, cover the enquiry message through precision or
    // through the owner's own clear, where the note could not sit cleanly, and
    // how many moved threads hold a post-floor reply
    // quoting a pre-floor message (see REPLY QUOTES).
    console.log(
      `[MigrateEnquiryThreadsToListingMailboxes] up ${JSON.stringify(outcomeRows)}`,
    );

    // Step 3: the owner's seat speaks for the listing. It keeps its history.
    await queryRunner.query(`
      UPDATE "conversation_participants" AS "owner_seat"
      SET "identity_id" = "move"."listing_identity_id"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND "owner_seat"."conversation_id" = "move"."conversation_id"
        AND "owner_seat"."user_id" = "move"."owner_user_id"
    `);

    // Step 4: every other active co-manager, floored just below the move
    // note so private history before the enquiry stays unreadable to them,
    // carrying the owner's own read and delivered watermarks (see WATERMARKS).
    await queryRunner.query(`
      INSERT INTO "conversation_participants" ("conversation_id", "user_id", "identity_id", "cleared_at", "last_read_at", "last_read_instant", "delivered_at")
      SELECT
        "move"."conversation_id",
        "co_manager"."user_id",
        "move"."listing_identity_id",
        "move"."staff_cleared_at",
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

    // Step 5: the owner's replies from the first enquiry on are the business's.
    await queryRunner.query(`
      UPDATE "messages" AS "message"
      SET "sender_identity_id" = "move"."listing_identity_id"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND "message"."conversation_id" = "move"."conversation_id"
        AND "message"."sender_id" = "move"."owner_user_id"
        AND "message"."created_at" >= "move"."floor_instant"
    `);

    // Step 6: exactly one note per moved thread, across rollbacks and re-runs,
    // stamped just above the co-manager floor and below the floor instant.
    await queryRunner.query(`
      INSERT INTO "messages" ("conversation_id", "sender_id", "sender_identity_id", "body", "kind", "system_event", "created_at")
      SELECT
        "move"."conversation_id",
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
        AND NOT EXISTS (
          SELECT 1 FROM "messages" AS "note"
          WHERE "note"."conversation_id" = "move"."conversation_id"
            AND "note"."kind" = 'system'
            AND "note"."system_event" ->> 'type' = 'moved_to_business_mailbox'
            AND "note"."system_event" ->> 'value' = "move"."listing_identity_id"::text
        )
    `);

    // Step 7: the thread is now keyed on the customer and the listing.
    await queryRunner.query(`
      UPDATE "conversations" AS "conversation"
      SET "pair_key" = "move"."new_pair_key"
      FROM "enquiry_thread_moves" AS "move"
      WHERE "move"."skip_reason" IS NULL
        AND "conversation"."id" = "move"."conversation_id"
    `);

    await queryRunner.query(`DROP TABLE "enquiry_thread_moves"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The threads `up()` moved, found through their note, whose owner seat
    // still speaks for the listing.
    await queryRunner.query(`
      CREATE TEMP TABLE "enquiry_thread_reverts" AS
      WITH "notes" AS (
        SELECT DISTINCT ON ("note"."conversation_id")
          "note"."conversation_id",
          ("note"."system_event" ->> 'actorId')::uuid AS "owner_user_id",
          ("note"."system_event" ->> 'value')::uuid AS "listing_identity_id"
        FROM "messages" AS "note"
        WHERE "note"."kind" = 'system'
          AND "note"."system_event" ->> 'type' = 'moved_to_business_mailbox'
        ORDER BY "note"."conversation_id", "note"."created_at" DESC
      ),
      "revert_facts" AS (
        SELECT
          "notes".*,
          "owner_profile"."id" AS "owner_identity_id",
          (
            SELECT MIN("customer_seat"."identity_id"::text)::uuid
            FROM "conversation_participants" AS "customer_seat"
            WHERE "customer_seat"."conversation_id" = "notes"."conversation_id"
              AND "customer_seat"."identity_id" <> "notes"."listing_identity_id"
          ) AS "customer_identity_id",
          (
            SELECT COUNT(*)
            FROM "conversation_participants" AS "customer_seat"
            WHERE "customer_seat"."conversation_id" = "notes"."conversation_id"
              AND "customer_seat"."identity_id" <> "notes"."listing_identity_id"
          ) AS "customer_seat_count"
        FROM "notes"
        JOIN "conversation_participants" AS "owner_seat"
          ON "owner_seat"."conversation_id" = "notes"."conversation_id"
          AND "owner_seat"."user_id" = "notes"."owner_user_id"
          AND "owner_seat"."identity_id" = "notes"."listing_identity_id"
        LEFT JOIN "identities" AS "owner_profile"
          ON "owner_profile"."user_id" = "notes"."owner_user_id"
          AND "owner_profile"."kind" = 'profile'
      ),
      "keyed_reverts" AS (
        SELECT
          "revert_facts".*,
          CASE
            WHEN "customer_identity_id"::text COLLATE "C" < "owner_identity_id"::text COLLATE "C"
              THEN "customer_identity_id"::text || ':' || "owner_identity_id"::text
            ELSE "owner_identity_id"::text || ':' || "customer_identity_id"::text
          END AS "restored_pair_key"
        FROM "revert_facts"
      )
      SELECT
        "keyed_reverts".*,
        CASE
          WHEN "owner_identity_id" IS NULL OR "customer_seat_count" <> 1
            THEN 'not_one_to_one'
          WHEN EXISTS (
            SELECT 1 FROM "conversations" AS "existing_thread"
            WHERE "existing_thread"."pair_key" = "keyed_reverts"."restored_pair_key"
              AND "existing_thread"."id" <> "keyed_reverts"."conversation_id"
          ) THEN 'personal_thread_exists'
          ELSE NULL
        END AS "skip_reason",
        (
          SELECT COUNT(*)
          FROM "messages" AS "staff_reply"
          WHERE "staff_reply"."conversation_id" = "keyed_reverts"."conversation_id"
            AND "staff_reply"."sender_identity_id" = "keyed_reverts"."listing_identity_id"
            AND "staff_reply"."sender_id" <> "keyed_reverts"."owner_user_id"
        ) AS "staff_reply_count"
      FROM "keyed_reverts"
    `);

    const outcomeRows: unknown = await queryRunner.query(`
      SELECT
        COALESCE("skip_reason", 'reverted') AS "outcome",
        COUNT(*) AS "threadCount",
        COALESCE(SUM("staff_reply_count"), 0) AS "staffReplyCount"
      FROM "enquiry_thread_reverts"
      GROUP BY COALESCE("skip_reason", 'reverted')
      ORDER BY COALESCE("skip_reason", 'reverted')
    `);
    console.log(
      `[MigrateEnquiryThreadsToListingMailboxes] down ${JSON.stringify(outcomeRows)}`,
    );

    // Reverses step 3.
    await queryRunner.query(`
      UPDATE "conversation_participants" AS "owner_seat"
      SET "identity_id" = "revert"."owner_identity_id"
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "owner_seat"."conversation_id" = "revert"."conversation_id"
        AND "owner_seat"."user_id" = "revert"."owner_user_id"
    `);

    // Reverses step 4, with any co-manager seated since.
    await queryRunner.query(`
      DELETE FROM "conversation_participants" AS "staff_seat"
      USING "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "staff_seat"."conversation_id" = "revert"."conversation_id"
        AND "staff_seat"."identity_id" = "revert"."listing_identity_id"
        AND "staff_seat"."user_id" <> "revert"."owner_user_id"
    `);

    // Reverses step 5. Owner messages before the floor never moved, so every
    // owner message on the listing identity here is one to hand back.
    await queryRunner.query(`
      UPDATE "messages" AS "message"
      SET "sender_identity_id" = "revert"."owner_identity_id"
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "message"."conversation_id" = "revert"."conversation_id"
        AND "message"."sender_id" = "revert"."owner_user_id"
        AND "message"."sender_identity_id" = "revert"."listing_identity_id"
    `);

    // Reverses step 7, and drops a claim that only means something in a mailbox.
    await queryRunner.query(`
      UPDATE "conversations" AS "conversation"
      SET
        "pair_key" = "revert"."restored_pair_key",
        "claimed_by_user_id" = NULL,
        "claimed_at" = NULL
      FROM "enquiry_thread_reverts" AS "revert"
      WHERE "revert"."skip_reason" IS NULL
        AND "conversation"."id" = "revert"."conversation_id"
    `);

    await queryRunner.query(`DROP TABLE "enquiry_thread_reverts"`);
  }
}
