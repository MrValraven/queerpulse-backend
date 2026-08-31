// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-32, part 4 of 4: the governance and roadmap tables whose foreign key to
 * `users` has no index on the child column, and the record of which columns
 * this change deliberately leaves alone.
 *
 * WHY, in short (part 1,
 * `1796300000000-AddCommunityErasureForeignKeyIndexes`, carries the full
 * argument). Postgres indexes only the referenced side of a foreign key, so
 * every FK to `users("id")` costs the erasure transaction one child lookup, and
 * an unindexed child column makes that lookup a sequential scan.
 *
 * GOVERNANCE IS THE WORST-SHAPED GROUP OF THE FOUR. `governance_votes` and
 * `governance_proposal_cosignatures` both index `(proposal_id, member_id)` and
 * nothing else, so `member_id` is the trailing column of the only index that
 * names it and cannot be seeked on its own. Both are append-only: a vote and a
 * co-signature are cast once and never deleted, so the tables grow with every
 * proposal the platform ever runs and never shrink. They are also the tables an
 * erased member is most likely to have rows in, because voting is the one
 * governance action open to everybody. Both columns are `NOT NULL`, so both get
 * a plain index with no predicate.
 *
 * `governance_proposals` carries FOUR edges to `users` and indexes exactly one
 * of them. `1794780000000-AddGovernanceMemberMotions` added
 * `proposed_by_member_id` with `IDX_governance_proposals_proposed_by_member_id`
 * behind it, because the per-member open-drive cap reads it. The three older or
 * quieter columns — `created_by_member_id`, `target_member_id`,
 * `screening_decided_by_member_id` — have nothing. All three are nullable and
 * sparse, so each gets `WHERE "<column>" IS NOT NULL`, which keeps the index
 * proportional to the rows that name somebody and still serves the erasure
 * lookup, because the RI trigger's `<column> = $1` uses a strict operator and
 * therefore implies the predicate. Part 1's docblock sets out that reasoning,
 * the repo precedents, and the write-amplification cost of the sixty-six
 * indexes this change adds across its four files.
 *
 * `roadmap_audit_log.actor_id` is the roadmap equivalent of
 * `community_governance_log.actor_user_id`: an append-only log indexed only by
 * `created_at`, so erasing anybody who has ever touched the roadmap scans all
 * of it. The other three roadmap columns are ordinary nullable author stamps on
 * much smaller tables, included for consistency rather than urgency; leaving
 * them out would mean the erasure path still had three sequential scans in it,
 * for no saving worth naming on tables this size.
 *
 * DELIBERATELY LEFT UNINDEXED. Three of the 69 unindexed foreign-key columns
 * this audit found get nothing, because an index would cost more than the scan
 * it replaces:
 *
 *  - `platform_settings.updated_by`. The table carries `CHECK ("id" = 1)`
 *    (`1782800790000-AddPlatformSettings`) and holds exactly one row, forever.
 *    Scanning one row is free; an index on it is pure overhead.
 *  - `governance_finance_report.metrics_edited_by`. One row per quarter,
 *    enforced by `UQ_governance_finance_report_quarter`. Four rows a year means
 *    the table will not reach three figures this decade, and the whole thing
 *    fits in a single page.
 *  - `mod_response_templates.created_by_user_id`. A curated list of canned
 *    moderator replies, bounded by staff writing them rather than by member
 *    activity, and already indexed on `(is_active, reason_code)` for the read
 *    that matters.
 *
 * The rule behind all three: a table is worth skipping only when its row count
 * is administratively bounded and cannot grow with membership or activity. The
 * finding's own framing is that this degrades as the audit tables grow, and
 * none of these three grows. Every other table on the list does, so every other
 * table gets its index.
 *
 * NON-TRANSACTIONAL. `CREATE INDEX CONCURRENTLY`, which Postgres forbids inside
 * any transaction block, so `transaction = false` opts out; that is honored
 * because `src/data-source.ts` sets `migrationsTransactionMode: 'each'`. The
 * migration is therefore not atomic: a mid-run failure leaves the indexes built
 * so far in place. No `IF NOT EXISTS` (forbidden repo-wide, it hides drift);
 * `scripts/migration-preflight.mjs` drops any INVALID index left by an
 * interrupted concurrent build as the first step of the deploy chain, so a
 * retry rebuilds cleanly. See that script's header for the contract.
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
export class AddGovernanceRoadmapErasureForeignKeyIndexes1796330000000 implements MigrationInterface {
  name = 'AddGovernanceRoadmapErasureForeignKeyIndexes1796330000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- append-only participation records, member column trailing a unique ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_governance_votes_member_id" ` +
        `ON "governance_votes" ("member_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_governance_proposal_cosignatures_member_id" ` +
        `ON "governance_proposal_cosignatures" ("member_id")`,
    );

    // --- the three unindexed proposal edges ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_governance_proposals_created_by_member_id" ` +
        `ON "governance_proposals" ("created_by_member_id") ` +
        `WHERE "created_by_member_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_governance_proposals_target_member_id" ` +
        `ON "governance_proposals" ("target_member_id") WHERE "target_member_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_governance_proposals_screening_decided_by_member_id" ` +
        `ON "governance_proposals" ("screening_decided_by_member_id") ` +
        `WHERE "screening_decided_by_member_id" IS NOT NULL`,
    );

    // --- roadmap ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_roadmap_audit_log_actor_id" ` +
        `ON "roadmap_audit_log" ("actor_id") WHERE "actor_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_roadmap_items_owner_id" ` +
        `ON "roadmap_items" ("owner_id") WHERE "owner_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_roadmap_ideas_submitted_by_id" ` +
        `ON "roadmap_ideas" ("submitted_by_id") WHERE "submitted_by_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_roadmap_item_comments_author_id" ` +
        `ON "roadmap_item_comments" ("author_id") WHERE "author_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_roadmap_item_comments_author_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_roadmap_ideas_submitted_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_roadmap_items_owner_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_roadmap_audit_log_actor_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_governance_proposals_screening_decided_by_member_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_governance_proposals_target_member_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_governance_proposals_created_by_member_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_governance_proposal_cosignatures_member_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_governance_votes_member_id"`,
    );
  }
}
