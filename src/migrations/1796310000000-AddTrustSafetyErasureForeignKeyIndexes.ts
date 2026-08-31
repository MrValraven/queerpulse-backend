// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-32, part 2 of 4: the trust, safety, verification and staff tables whose
 * foreign key to `users` has no index on the child column.
 *
 * WHY, in short (part 1,
 * `1796300000000-AddCommunityErasureForeignKeyIndexes`, carries the full
 * argument). Postgres indexes only the referenced side of a foreign key. Every
 * FK to `users("id")` therefore costs one child lookup per erased account, and
 * with no index on the child column that lookup is a sequential scan, inside
 * the transaction `AccountDeletionProcessorService.eraseAccount` holds while a
 * member waits. This file covers the 22 such columns in the review, appeal and
 * verification surfaces.
 *
 * TWO OF THESE ARE WORSE THAN THE REST. `users.invited_by` is self-referential:
 * `Init1782691200000` declares it `ON DELETE SET NULL` and never indexes it, so
 * deleting ANY user sequentially scans the entire `users` table to find the
 * people they invited. It is the single largest table in the erasure path and
 * the only one that is guaranteed to be scanned on every erasure, invited or
 * not. `profiles.verified_by` is the same shape one table over: one profile row
 * per member, and the column is set only for the small minority who were
 * manually verified.
 *
 * `reports.resolution_actor_id` deserves its own note because `reports` is
 * already the most heavily indexed table on the platform (eleven indexes) and
 * this adds a twelfth. It earns it: the moderation queue is append-only in
 * practice, `resolution_actor_id` is written once when a moderator closes a
 * report, and erasing a moderator who has ever resolved anything currently
 * scans every report ever filed. The partial predicate keeps the new index to
 * roughly the number of RESOLVED reports rather than all of them.
 *
 * `user_staff_roles.granted_by` was missed by the audit that produced the rest
 * of this list, because `1785855956158-AddUserStaffRoles` builds its table with
 * TypeORM's `new Table(...)` object API rather than raw SQL. It indexes
 * `user_id` (`idx_user_staff_roles_user`) and declares a second
 * `TableForeignKey` on `granted_by` with no index behind it.
 *
 * ALL 22 COLUMNS HERE ARE NULLABLE, and all of them are sparse: a reviewer, a
 * resolver, an assignee, a scanner, an inviter. Each therefore gets
 * `WHERE "<column>" IS NOT NULL`, which keeps the index to the rows that
 * actually name somebody and still serves the erasure lookup, because the RI
 * trigger's `<column> = $1` uses a strict operator and so implies the
 * predicate. Part 1's docblock sets out that reasoning and the repo precedents
 * in full.
 *
 * `intake_submissions.assigned_staff_id` and `partners.assigned_staff_id` are
 * a deliberate revision of a decision made in
 * `1795640000000-AddQueueAssignmentAndDueClocks`, which added
 * `assigned_staff_id` to four queues and indexed only the two whose consoles
 * filter by assignee. That was the right call for READ paths and the wrong one
 * once the erasure cost is counted: a staff member exercising their own right
 * to erasure sets every row they were holding back to unassigned, and on these
 * two queues that is a sequential scan. The index is now justified by the write
 * path even though no read needs it.
 *
 * NON-TRANSACTIONAL. `CREATE INDEX CONCURRENTLY` (Postgres forbids it inside
 * any transaction block, hence `transaction = false`, honored because
 * `src/data-source.ts` sets `migrationsTransactionMode: 'each'`), so `users`,
 * `profiles` and `reports` are never locked against writes during the build.
 * The migration is consequently not atomic: a mid-run failure leaves the
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
export class AddTrustSafetyErasureForeignKeyIndexes1796310000000 implements MigrationInterface {
  name = 'AddTrustSafetyErasureForeignKeyIndexes1796310000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- the two whole-table scans on every erasure ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_users_invited_by" ` +
        `ON "users" ("invited_by") WHERE "invited_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_verified_by" ` +
        `ON "profiles" ("verified_by") WHERE "verified_by" IS NOT NULL`,
    );

    // --- reports and moderation tooling ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_reports_resolution_actor_id" ` +
        `ON "reports" ("resolution_actor_id") WHERE "resolution_actor_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_user_staff_roles_granted_by" ` +
        `ON "user_staff_roles" ("granted_by") WHERE "granted_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_status_incidents_authored_by_user_id" ` +
        `ON "status_incidents" ("authored_by_user_id") WHERE "authored_by_user_id" IS NOT NULL`,
    );

    // --- verification and identity ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_verification_requests_reviewed_by_user_id" ` +
        `ON "verification_requests" ("reviewed_by_user_id") ` +
        `WHERE "reviewed_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_verification_events_actor_user_id" ` +
        `ON "verification_events" ("actor_user_id") WHERE "actor_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_member_verifications_reviewed_by_user_id" ` +
        `ON "member_verifications" ("reviewed_by_user_id") ` +
        `WHERE "reviewed_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_identity_relink_candidates_decided_by_user_id" ` +
        `ON "identity_relink_candidates" ("decided_by_user_id") ` +
        `WHERE "decided_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_membership_card_scans_scanned_by_user_id" ` +
        `ON "membership_card_scans" ("scanned_by_user_id") ` +
        `WHERE "scanned_by_user_id" IS NOT NULL`,
    );

    // --- privacy and legal ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_dsar_request_resolved_by_user_id" ` +
        `ON "dsar_request" ("resolved_by_user_id") WHERE "resolved_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_legal_requests_recorded_by_user_id" ` +
        `ON "legal_requests" ("recorded_by_user_id") WHERE "recorded_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_legal_requests_voided_by_user_id" ` +
        `ON "legal_requests" ("voided_by_user_id") WHERE "voided_by_user_id" IS NOT NULL`,
    );

    // --- safe-space review workflow ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_safe_space_nominations_acknowledged_by" ` +
        `ON "safe_space_nominations" ("acknowledged_by") WHERE "acknowledged_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_safe_space_nominations_assigned_by" ` +
        `ON "safe_space_nominations" ("assigned_by") WHERE "assigned_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_safe_space_nominations_decided_by" ` +
        `ON "safe_space_nominations" ("decided_by") WHERE "decided_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_safe_space_flags_resolved_by" ` +
        `ON "safe_space_flags" ("resolved_by") WHERE "resolved_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_safe_space_badge_suspensions_suspended_by" ` +
        `ON "safe_space_badge_suspensions" ("suspended_by") WHERE "suspended_by" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_safe_space_badge_suspensions_lifted_by" ` +
        `ON "safe_space_badge_suspensions" ("lifted_by") WHERE "lifted_by" IS NOT NULL`,
    );

    // --- the two queues 1795640000000 left unindexed on read-path grounds ---
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_intake_submissions_assigned_staff_id" ` +
        `ON "intake_submissions" ("assigned_staff_id") WHERE "assigned_staff_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_partners_assigned_staff_id" ` +
        `ON "partners" ("assigned_staff_id") WHERE "assigned_staff_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_changemaker_nomination_reviewed_by" ` +
        `ON "changemaker_nomination" ("reviewed_by") WHERE "reviewed_by" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_changemaker_nomination_reviewed_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_partners_assigned_staff_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_intake_submissions_assigned_staff_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_safe_space_badge_suspensions_lifted_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_safe_space_badge_suspensions_suspended_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_safe_space_flags_resolved_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_safe_space_nominations_decided_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_safe_space_nominations_assigned_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_safe_space_nominations_acknowledged_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_legal_requests_voided_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_legal_requests_recorded_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_dsar_request_resolved_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_membership_card_scans_scanned_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_identity_relink_candidates_decided_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_member_verifications_reviewed_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_verification_events_actor_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_verification_requests_reviewed_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_status_incidents_authored_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_user_staff_roles_granted_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_reports_resolution_actor_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_profiles_verified_by"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_users_invited_by"`,
    );
  }
}
