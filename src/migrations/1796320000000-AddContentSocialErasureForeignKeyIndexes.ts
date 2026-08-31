// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-32, part 3 of 4: the content, events, listings and social tables whose
 * foreign key to `users` has no index on the child column.
 *
 * WHY, in short (part 1,
 * `1796300000000-AddCommunityErasureForeignKeyIndexes`, carries the full
 * argument). Postgres indexes only the referenced side of a foreign key, so
 * every FK to `users("id")` costs the erasure transaction one child lookup, and
 * an unindexed child column makes that lookup a sequential scan. This file
 * covers the 17 such columns outside the community, trust-and-safety and
 * governance groupings.
 *
 * FIVE OF THESE ARE `NOT NULL` AND HIDING BEHIND A COMPOSITE UNIQUE, which is
 * the trap worth naming because the tables look indexed until you check which
 * column leads:
 *
 *   conversation_pinned_messages.pinned_by   (no index names it at all)
 *   event_cohost_invites.inviter_id          UQ (event_id, invitee_id)
 *   event_invites.inviter_id                 UQ (event_id, invitee_id)
 *   event_lineup_entries.user_id             UQ (event_id, user_id)
 *   listing_review_helpful_votes.voter_id    UQ (review_id, voter_id)
 *   member_suggestion_dismissals.dismissed_user_id
 *                                            UQ (user_id, dismissed_user_id)
 *   resource_guide_rating.member_id          UQ (content_key, member_id)
 *
 * In each case the member column is the SECOND column of the unique index, and
 * Postgres cannot seek into a b-tree by a non-leading column, so none of those
 * uniques can answer `WHERE <member column> = $1`. They get plain indexes,
 * with no `IS NOT NULL` predicate: the columns are `NOT NULL`, so the predicate
 * would exclude nothing and only mislead a later reader.
 *
 * `member_suggestion_dismissals` is the one to watch as the platform grows. It
 * accumulates a row per (member, dismissed suggestion) pair, so it grows with
 * the SQUARE of the directory rather than with membership, and it carries two
 * edges to `users` of which only `user_id` is indexed. Erasing a member scans
 * the whole table to clear the rows where other people dismissed THEM.
 *
 * The remaining ten are nullable actor stamps: a tombstone actor
 * (`forum_post.deleted_by_id`), an editor, an answerer, an introducer, a
 * completer, a decider. Each gets `WHERE "<column>" IS NOT NULL`, which keeps
 * the index proportional to the rows that name somebody instead of to the whole
 * table, and still serves the erasure lookup because the RI trigger's
 * `<column> = $1` uses a strict operator and therefore implies the predicate.
 * Part 1's docblock sets out that reasoning and the repo precedents in full,
 * along with the write-amplification cost of the sixty-six indexes this change
 * adds across its four files.
 *
 * `forum_post.deleted_by_id` and `forum_post_edit.editor_id` are the two that
 * most need the partial form. Forum posts are the highest-volume content rows
 * on the platform and almost none of them are moderator-deleted, so a full
 * index would be one entry per post to answer a question about a few hundred.
 *
 * NOT COVERED HERE, on purpose: `topic_post.author_id` and
 * `magazine_author.user_id`. Both already have a partial index leading with the
 * FK column (`IDX_topic_post_author_id`, `UQ_magazine_author_user_id`, both
 * `WHERE <column> IS NOT NULL`), which is exactly the shape this file adds
 * elsewhere. They need nothing.
 *
 * NON-TRANSACTIONAL. `CREATE INDEX CONCURRENTLY`, which Postgres forbids inside
 * any transaction block, so `transaction = false` opts out; that is honored
 * because `src/data-source.ts` sets `migrationsTransactionMode: 'each'`.
 * `forum_post`, `listings` and the event tables stay writable through the
 * build. The migration is therefore not atomic: a mid-run failure leaves the
 * indexes built so far in place. No `IF NOT EXISTS` (forbidden repo-wide, it
 * hides drift); `scripts/migration-preflight.mjs` drops any INVALID index left
 * by an interrupted concurrent build as the first step of the deploy chain, so
 * a retry rebuilds cleanly. See that script's header for the contract.
 *
 * `down()` drops the same indexes, also `CONCURRENTLY`, in reverse order.
 * Each drop is guarded with `IF EXISTS`, the existing convention here (see
 * `1793640000000-AddContentModuleForeignKeyIndexes`). The repo-wide ban is on
 * `IF NOT EXISTS` when CREATING, where it hides drift by turning a missing
 * object into a silent success. Guarding a DROP has the opposite character: it
 * asserts only that the object is gone afterwards, and it is what makes a
 * revert possible after the partial `up()` described above, where some of these
 * indexes exist and the rest were never built.
 */
export class AddContentSocialErasureForeignKeyIndexes1796320000000 implements MigrationInterface {
  name = 'AddContentSocialErasureForeignKeyIndexes1796320000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- NOT NULL member columns that trail a composite unique ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_conversation_pinned_messages_pinned_by" ` +
        `ON "conversation_pinned_messages" ("pinned_by")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_event_cohost_invites_inviter_id" ` +
        `ON "event_cohost_invites" ("inviter_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_event_invites_inviter_id" ` +
        `ON "event_invites" ("inviter_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_event_lineup_entries_user_id" ` +
        `ON "event_lineup_entries" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listing_review_helpful_votes_voter_id" ` +
        `ON "listing_review_helpful_votes" ("voter_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_member_suggestion_dismissals_dismissed_user_id" ` +
        `ON "member_suggestion_dismissals" ("dismissed_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_resource_guide_rating_member_id" ` +
        `ON "resource_guide_rating" ("member_id")`,
    );

    // --- forum and messaging provenance ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_post_deleted_by_id" ` +
        `ON "forum_post" ("deleted_by_id") WHERE "deleted_by_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_post_edit_editor_id" ` +
        `ON "forum_post_edit" ("editor_id") WHERE "editor_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_conversations_created_by" ` +
        `ON "conversations" ("created_by") WHERE "created_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_connections_introduced_by" ` +
        `ON "connections" ("introduced_by") WHERE "introduced_by" IS NOT NULL`,
    );

    // --- gatherings ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_event_announcements_author_id" ` +
        `ON "event_announcements" ("author_id") WHERE "author_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_event_bans_banned_by_user_id" ` +
        `ON "event_bans" ("banned_by_user_id") WHERE "banned_by_user_id" IS NOT NULL`,
    );

    // --- listings, housing and volunteering ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_decided_by_id" ` +
        `ON "housing_listings" ("decided_by_id") WHERE "decided_by_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listing_co_managers_invited_by_user_id" ` +
        `ON "listing_co_managers" ("invited_by_user_id") WHERE "invited_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listing_public_questions_answered_by_id" ` +
        `ON "listing_public_questions" ("answered_by_id") WHERE "answered_by_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_volunteer_signups_completed_by_id" ` +
        `ON "volunteer_signups" ("completed_by_id") WHERE "completed_by_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_volunteer_signups_completed_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_listing_public_questions_answered_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_listing_co_managers_invited_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_housing_listings_decided_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_event_bans_banned_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_event_announcements_author_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_connections_introduced_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_conversations_created_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_forum_post_edit_editor_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_forum_post_deleted_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_resource_guide_rating_member_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_member_suggestion_dismissals_dismissed_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_listing_review_helpful_votes_voter_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_event_lineup_entries_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_event_invites_inviter_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_event_cohost_invites_inviter_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_conversation_pinned_messages_pinned_by"`,
    );
  }
}
