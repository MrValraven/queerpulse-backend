import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Moves `conversations.pair_key` from a sorted pair of user ids to a sorted
 * pair of identity ids. Every existing one-to-one thread is between two people
 * acting as themselves, so each key becomes the sorted pair of the two profile
 * identities. Group and official conversations keep a null `pair_key` and are
 * untouched.
 *
 * Runs after the identity backfill of `1821220000000` and before the enquiry
 * migration, which relies on the new key shape to move a thread into a
 * listing mailbox without colliding with a personal thread between the same
 * two people.
 *
 * LOCKS. This is a plain `UPDATE`, so it never takes an ACCESS EXCLUSIVE lock
 * and never rebuilds the `UQ_conversations_pair_key` index (that index
 * already exists from `AddMessaging`; only the values under it change). The
 * inner `SELECT` against `conversation_participants` takes only an ACCESS
 * SHARE lock, which does not block inserts, updates or deletes on that
 * table. The `UPDATE` itself takes the ordinary ROW EXCLUSIVE table lock on
 * `conversations` plus a row-level lock on each row it rewrites, held until
 * commit; both are the same footprint any application `UPDATE` already
 * takes on that table, and neither blocks concurrent reads or writes to rows
 * this statement does not touch. `conversations` holds one row per pair or
 * group, so it is far smaller than `messages`/`conversation_participants`
 * (see `1820530000000` and `1821235000000`'s own docs on why THOSE tables
 * needed `CONCURRENTLY` and a split transaction).
 * That is why this migration keeps the ordinary per-migration transaction
 * (unlike its two siblings above): there is no `CREATE INDEX CONCURRENTLY`
 * or `NOT VALID` staging here for a transaction to get in the way of, and
 * wrapping the single `UPDATE` atomically is strictly safer than opting out.
 *
 * The inner `SELECT` is scoped with a `WHERE conversation_id IN (...)`
 * against `conversations` with a non-null `pair_key`, so it aggregates only
 * the participant rows of a one-to-one or official thread rather than
 * scanning every row of every group conversation too.
 *
 * COLLATION. `MIN`/`MAX` order the two identity ids as text to reproduce the
 * exact sort `MessagingCoreService.identityPairKey` performs in
 * JavaScript (`[a, b].sort()`, a plain UTF-16 code-unit comparison). Both
 * sides are cast `COLLATE "C"` so Postgres compares the same way regardless
 * of the database's default collation, which could otherwise order
 * punctuation differently from a byte-wise compare and rewrite a pair_key
 * that `getOrCreateConversation`'s own lookup would never produce or find
 * again.
 *
 * DOWN IS ONLY SAFE BEFORE A MEMBER HOLDS TWO THREADS WITH THE SAME
 * COUNTERPART. Reverting to a user-id pair_key after Tasks 7/8 ship business
 * mailboxes would collapse a customer's personal thread with an owner and
 * their separate thread with that owner's shop onto the identical
 * "lowUserId:highUserId" key, tripping the UNIQUE index this migration never
 * touches. Run `down()` only while every `pair_key` still describes exactly
 * one identity pair per user pair, guaranteed immediately after `up()` for as
 * long as no business thread yet exists.
 */
export class RewritePairKeyToIdentities1821240000000 implements MigrationInterface {
  name = 'RewritePairKeyToIdentities1821240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH "pairs" AS (
        SELECT
          "participant"."conversation_id" AS "conversationId",
          MIN("participant"."identity_id"::text COLLATE "C") AS "lowIdentityId",
          MAX("participant"."identity_id"::text COLLATE "C") AS "highIdentityId",
          COUNT(*) AS "seatCount"
        FROM "conversation_participants" AS "participant"
        WHERE "participant"."conversation_id" IN (
          SELECT "id" FROM "conversations" WHERE "pair_key" IS NOT NULL
        )
        GROUP BY "participant"."conversation_id"
      )
      UPDATE "conversations" AS "conversation"
      SET "pair_key" = "pairs"."lowIdentityId" || ':' || "pairs"."highIdentityId"
      FROM "pairs"
      WHERE "pairs"."conversationId" = "conversation"."id"
        AND "conversation"."pair_key" IS NOT NULL
        AND "pairs"."seatCount" = 2
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH "pairs" AS (
        SELECT
          "participant"."conversation_id" AS "conversationId",
          MIN("participant"."user_id"::text COLLATE "C") AS "lowUserId",
          MAX("participant"."user_id"::text COLLATE "C") AS "highUserId",
          COUNT(*) AS "seatCount"
        FROM "conversation_participants" AS "participant"
        WHERE "participant"."conversation_id" IN (
          SELECT "id" FROM "conversations" WHERE "pair_key" IS NOT NULL
        )
        GROUP BY "participant"."conversation_id"
      )
      UPDATE "conversations" AS "conversation"
      SET "pair_key" = "pairs"."lowUserId" || ':' || "pairs"."highUserId"
      FROM "pairs"
      WHERE "pairs"."conversationId" = "conversation"."id"
        AND "conversation"."pair_key" IS NOT NULL
        AND "pairs"."seatCount" = 2
    `);
  }
}
