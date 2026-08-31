import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `communities.frozen_reason` — WHY a community is frozen, so lifting the
 * freeze can be gated on it (BE-COM-04).
 *
 * `CommunityAutoFreezeService` freezes a community when an `emergency`
 * severity report (outing/doxxing) lands or its open reports reach the
 * pile-up threshold, but `CommunitiesService.unfreeze` only required an
 * owner/mod role, so the owner of a community frozen over an outing report
 * could lift it immediately and keep operating. Nothing on the row
 * distinguished that from a manual freeze the same owner had set themselves.
 *
 * Three values, matching the `reason` string the freeze paths already write to
 * the governance log and the staff notification payload:
 *  - `manual`           — an owner/mod froze it from the mod panel.
 *  - `emergency_report` — auto-freeze on an emergency-severity report.
 *  - `report_pileup`    — auto-freeze on open reports reaching the threshold.
 *
 * Nullable: NULL means "not frozen", and also covers any row frozen before
 * this column existed (treated as an automatic freeze by `unfreeze` — the
 * safe direction, since a manual freeze is the one an owner may always lift).
 */
export class AddCommunityFrozenReason1793520100000 implements MigrationInterface {
  name = 'AddCommunityFrozenReason1793520100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "communities_frozen_reason_enum" AS ENUM (
        'manual', 'emergency_report', 'report_pileup'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "communities"
        ADD "frozen_reason" "communities_frozen_reason_enum"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "frozen_reason"`,
    );
    await queryRunner.query(`DROP TYPE "communities_frozen_reason_enum"`);
  }
}
