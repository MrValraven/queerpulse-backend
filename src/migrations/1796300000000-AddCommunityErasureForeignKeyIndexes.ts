// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-32, part 1 of 4: the community and ban tables whose foreign key to
 * `users` has no index on the child column.
 *
 * WHY. Postgres indexes only the REFERENCED side of a foreign key, never the
 * referencing one. So for every FK a child table declares to `users("id")`,
 * deleting a user makes the referential-integrity trigger run one lookup per
 * constraint, `WHERE <child column> = $1`, and with no index that lookup is a
 * sequential scan of the whole child table. `AccountDeletionProcessorService`
 * erases a member by hard-deleting the `users` row and letting `ON DELETE
 * CASCADE` and `ON DELETE SET NULL` do the rest, all inside one transaction a
 * member is waiting on. Auditing the 244 foreign keys that reference `users`
 * across the migration history found 69 child columns with no usable index;
 * this file closes the 18 of them that live in the community and ban tables.
 *
 * `community_governance_log` is the clearest case and the one that will hurt
 * first. It is a pure audit table: every moderation action in every community
 * appends a row and nothing ever deletes one, so it only grows, and it carries
 * TWO edges to `users`. `target_user_id` is already reachable through
 * `IDX_community_governance_log_target_created_at`
 * (`1795790000000-AddGovernanceLogTargetLookupIndex`), but `actor_user_id` has
 * nothing, so erasing anyone who has ever moderated anything scans the entire
 * log. `community_bans` is the same shape: `UQ_community_bans_community_user`
 * covers `(community_id, user_id)`, which serves a "is this member banned
 * here?" probe but cannot serve the erasure lookup on `user_id` alone, because
 * `user_id` is the SECOND column of that index and Postgres cannot seek into a
 * b-tree by a non-leading column.
 *
 * These indexes are not only for erasure. Every one of them also serves any
 * read that filters the child table by that column: "which communities did this
 * member freeze", "who claimed this join request", "what has this moderator
 * done". The erasure path is simply the one that is guaranteed to touch all of
 * them, on a clock.
 *
 * PARTIAL WHERE THE COLUMN IS NULLABLE. Fifteen of the eighteen are nullable
 * actor stamps: `deleted_by_id`, `editor_id`, `frozen_by_user_id`,
 * `claimed_by_user_id` and their kin are NULL on the overwhelming majority of
 * rows, and a plain b-tree indexes NULLs, so a full index on
 * `community_posts.deleted_by_id` would be nearly one entry per post to answer
 * a question about the handful that were removed by a moderator. Each of those
 * gets `WHERE "<column>" IS NOT NULL` instead. That predicate still serves the
 * erasure lookup: the RI trigger's clause is `<column> = $1` with a strict
 * operator, which implies `<column> IS NOT NULL`, and the planner proves that
 * implication and uses the partial index. It is the pattern this repo already
 * relies on for exactly this shape of column, in `IDX_topic_post_author_id`,
 * `UQ_magazine_author_user_id` and
 * `IDX_community_governance_log_target_created_at`. `community_bans.user_id` is
 * `NOT NULL`, so it gets a plain index; a redundant `IS NOT NULL` predicate
 * there would only mislead a later reader.
 *
 * THE COST, PLAINLY. Sixty-six indexes across the four files of this change is
 * sixty-six more b-trees to maintain. Every INSERT into these tables, and every
 * UPDATE that touches an indexed column, now does more work, and each index
 * occupies disk and competes for shared buffers. Two things make that trade
 * worth taking here. The partial predicates mean the sparse actor columns cost
 * almost nothing to maintain: a row inserted with a NULL `deleted_by_id` adds
 * no index entry at all, so the ordinary write path for posts, replies and
 * edits is untouched. And the alternative is not "no cost", it is an erasure
 * transaction whose duration grows with the size of every audit table on the
 * platform, holding row locks across all of them while it runs.
 *
 * NON-TRANSACTIONAL, ON PURPOSE. `community_governance_log`,
 * `community_posts` and `community_post_replies` are among the largest tables
 * here and this migration runs in a pre-deploy step against the live database,
 * so a plain `CREATE INDEX` taking an `ACCESS EXCLUSIVE`-adjacent write lock on
 * them for the length of the build is not acceptable. `CREATE INDEX
 * CONCURRENTLY` builds without blocking writers, and Postgres forbids it inside
 * any transaction block (error 25001), so `transaction = false` opts this
 * migration out. That is honored only because `src/data-source.ts` sets
 * `migrationsTransactionMode: 'each'`; under the default `all` mode TypeORM
 * would reject the override outright. The consequence is that this migration is
 * NOT atomic: a failure partway through leaves the indexes built so far in
 * place, and re-running it will fail on the first one that already exists.
 * Recovery is to drop the ones that landed, or to split the remainder into a
 * follow-up.
 *
 * NO `IF NOT EXISTS`, deliberately: it is forbidden repo-wide because it hides
 * schema drift, turning "this index was never built" into a silent success.
 * The failure mode it would paper over is already handled properly by
 * `scripts/migration-preflight.mjs`, which runs as the FIRST step of the deploy
 * chain and drops any INVALID index left behind by an interrupted concurrent
 * build before migrations run, so the retry rebuilds cleanly. See that script's
 * header for the contract.
 *
 * SPLIT ACROSS FOUR FILES by domain (community/bans here, then trust and
 * safety, content and social, governance and roadmap). One migration issuing
 * sixty-six sequential concurrent builds would be a single very long
 * non-transactional step whose partial failure is maximally awkward to unpick;
 * four smaller ones fail in a smaller blast radius and can be run and reviewed
 * independently.
 *
 * `down()` drops the same indexes, also `CONCURRENTLY` and also outside a
 * transaction, in reverse order.
 * Each drop is guarded with `IF EXISTS`, the existing convention here (see
 * `1793640000000-AddContentModuleForeignKeyIndexes`). The repo-wide ban is on
 * `IF NOT EXISTS` when CREATING, where it hides drift by turning a missing
 * object into a silent success. Guarding a DROP has the opposite character: it
 * asserts only that the object is gone afterwards, and it is what makes a
 * revert possible after the partial `up()` described above, where some of these
 * indexes exist and the rest were never built.
 */
export class AddCommunityErasureForeignKeyIndexes1796300000000 implements MigrationInterface {
  name = 'AddCommunityErasureForeignKeyIndexes1796300000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- ban and appeal machinery ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_ban_evasion_escalations_raised_by_user_id" ` +
        `ON "ban_evasion_escalations" ("raised_by_user_id") WHERE "raised_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_ban_evasion_escalations_resolved_by_user_id" ` +
        `ON "ban_evasion_escalations" ("resolved_by_user_id") WHERE "resolved_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_ban_evasion_escalations_subject_user_id" ` +
        `ON "ban_evasion_escalations" ("subject_user_id") WHERE "subject_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_ban_ratifications_decided_by" ` +
        `ON "ban_ratifications" ("decided_by") WHERE "decided_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_ban_ratifications_decided_by" ` +
        `ON "community_ban_ratifications" ("decided_by") WHERE "decided_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_bans_banned_by_user_id" ` +
        `ON "community_bans" ("banned_by_user_id") WHERE "banned_by_user_id" IS NOT NULL`,
    );
    // NOT NULL, and the second column of UQ_community_bans_community_user,
    // which is why the unique index cannot answer the erasure lookup.
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_bans_user_id" ` +
        `ON "community_bans" ("user_id")`,
    );

    // --- community records and moderation ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_communities_frozen_by_user_id" ` +
        `ON "communities" ("frozen_by_user_id") WHERE "frozen_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_governance_log_actor_user_id" ` +
        `ON "community_governance_log" ("actor_user_id") WHERE "actor_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_join_requests_claimed_by_user_id" ` +
        `ON "community_join_requests" ("claimed_by_user_id") WHERE "claimed_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_owner_review_requests_requested_by_user_id" ` +
        `ON "community_owner_review_requests" ("requested_by_user_id") ` +
        `WHERE "requested_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_resources_created_by_user_id" ` +
        `ON "community_resources" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_support_offers_offered_by_user_id" ` +
        `ON "community_support_offers" ("offered_by_user_id") WHERE "offered_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_support_offers_responded_by_user_id" ` +
        `ON "community_support_offers" ("responded_by_user_id") ` +
        `WHERE "responded_by_user_id" IS NOT NULL`,
    );

    // --- post and reply provenance (editor and tombstone actor) ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_post_edit_editor_id" ` +
        `ON "community_post_edit" ("editor_id") WHERE "editor_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_post_reply_edit_editor_id" ` +
        `ON "community_post_reply_edit" ("editor_id") WHERE "editor_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_posts_deleted_by_id" ` +
        `ON "community_posts" ("deleted_by_id") WHERE "deleted_by_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_post_replies_deleted_by_id" ` +
        `ON "community_post_replies" ("deleted_by_id") WHERE "deleted_by_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_post_replies_deleted_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_posts_deleted_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_post_reply_edit_editor_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_post_edit_editor_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_support_offers_responded_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_support_offers_offered_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_resources_created_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_owner_review_requests_requested_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_join_requests_claimed_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_governance_log_actor_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_communities_frozen_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_bans_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_bans_banned_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_community_ban_ratifications_decided_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_ban_ratifications_decided_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_ban_evasion_escalations_subject_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_ban_evasion_escalations_resolved_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_ban_evasion_escalations_raised_by_user_id"`,
    );
  }
}
