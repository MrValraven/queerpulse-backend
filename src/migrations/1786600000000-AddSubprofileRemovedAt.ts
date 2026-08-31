import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds a nullable `removed_at` timestamptz to `subprofiles`, backing the new
// `removed` restricted-state signal on the public persona read
// (`SubprofilesService.resolvePublicAccess`/`buildPublicView`; see the design
// plan `docs/superpowers/plans/2026-08-10-personas-phase1b-restricted-states.md`).
//
// Non-goal (documented in the plan): nothing SETS this column yet. The admin
// takedown action that would is a separate, later moderation-console feature
// — for now `removed_at` is DB-settable only.
export class AddSubprofileRemovedAt1786600000000 implements MigrationInterface {
  name = 'AddSubprofileRemovedAt1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofiles" ADD COLUMN "removed_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofiles" DROP COLUMN "removed_at"`,
    );
  }
}
