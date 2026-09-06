// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-263 — adds `partners.owner_user_id`, the member account that MAINTAINS
 * an approved partner's public profile.
 *
 * WHY A SECOND COLUMN RATHER THAN REUSING `submitted_by_id`. The submitter
 * column already exists and is NOT NULL, so the scan's premise that a partner
 * "may have no owning user at all" does not hold for any row created through
 * the API. But the two columns answer different questions and must be allowed
 * to diverge:
 *
 *  - `submitted_by_id` is the historical record of WHO FILED the application.
 *    It is what the decision notification is addressed to, what the admin
 *    queue attributes the row to, and it must never move, or the audit trail
 *    of who asked for the partnership is rewritten.
 *  - `owner_user_id` is a LIVE PERMISSION. The person who filled the form in
 *    leaves the organisation; the seat has to be transferable by staff without
 *    falsifying the application record.
 *
 * NULLABLE, unlike the submitter. Three states are real and distinguishable:
 * a pending application has no owner yet (nobody may edit a row that is not a
 * partner), an approved partner normally has one, and an approved partner
 * whose owning account was erased has none and falls back to staff-only
 * editing. `ON DELETE SET NULL` is what produces that last state, mirroring
 * `inquiries.handled_by_id`: erasing a member must de-link the profile, never
 * delete the partner.
 *
 * BACKFILL. Every APPROVED row takes its submitter as its first owner, which
 * is exactly the rule `PartnersService.triage` now applies going forward at
 * approval time. Pending and rejected rows are deliberately left NULL: they
 * are not partners, they have no public profile to maintain, and stamping an
 * owner on them would hand edit rights to a row that may yet be refused. The
 * backfill cannot violate the new constraint: `submitted_by_id` already
 * references a live `users` row, so every value it copies across is one the
 * FK accepts.
 *
 * INDEX. `IDX_partners_owner_user_id` serves the one query the self-service
 * editor makes on every load ("which partners do I maintain?"), which would
 * otherwise scan the whole table for a member who maintains none.
 */
export class AddPartnerOwnerUserId1812050000000 implements MigrationInterface {
  name = 'AddPartnerOwnerUserId1812050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "partners" ADD COLUMN "owner_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "partners" ADD CONSTRAINT "FK_partners_owner_user_id" ` +
        `FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_partners_owner_user_id" ON "partners" ("owner_user_id")`,
    );
    await queryRunner.query(
      `UPDATE "partners" SET "owner_user_id" = "submitted_by_id" ` +
        `WHERE "status" = 'approved' AND "owner_user_id" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_partners_owner_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "partners" DROP CONSTRAINT "FK_partners_owner_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "partners" DROP COLUMN "owner_user_id"`,
    );
  }
}
