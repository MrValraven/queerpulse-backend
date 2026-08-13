import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives the Work Profile's "Skills & focus" section somewhere to live.
 *
 * Until now those two multi-selects were static, read-only chips on the
 * frontend — a member could not actually pick anything, and nothing was stored.
 * Making them selectable (`WORK_SKILLS` / `FOCUS_AREAS` in
 * `features/economy/workProfile.data.ts`, saved through the existing
 * `PUT /me/work-preferences`) needs two columns on the row that already holds
 * the member's other work-profile settings.
 *
 * Both are `text[] DEFAULT '{}'`, mirroring `trans_support` on the same table:
 * closed-set multi-selects whose option list belongs to the frontend catalogue
 * and is expected to grow, so they are range-checked by
 * `@IsIn(..., {each:true})` in `UpdateWorkPreferencesDto` rather than frozen
 * into a Postgres enum that would need a migration per new option. The `{}`
 * defaults are kept in lockstep with the entity columns and with
 * `PreferencesService.defaults`, so an existing member with no row still reads
 * as "nothing selected" rather than 404ing (no backfill — same reasoning as
 * AddProfileSafetyPreferences1782800760000).
 */
export class AddWorkSkillsFocusAreas1788500000000 implements MigrationInterface {
  name = 'AddWorkSkillsFocusAreas1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD "skills" text array NOT NULL DEFAULT '{}',
        ADD "focus_areas" text array NOT NULL DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        DROP COLUMN "focus_areas",
        DROP COLUMN "skills"
    `);
  }
}
