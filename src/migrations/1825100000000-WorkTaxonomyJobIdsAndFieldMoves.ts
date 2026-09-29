// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  COMMITMENT_IDS_AT_MIGRATION,
  FIELD_TO_LEGACY_CATEGORY,
  JOB_FIELD_IDS_AT_MIGRATION,
  LEGACY_CATEGORY_TO_FIELD,
  LEGACY_COMMITMENT_LABEL_BY_ID,
  LEGACY_COMMITMENT_TO_ID,
  LEGACY_SENIORITY_LABEL_BY_ID,
  LEGACY_SENIORITY_TO_ID,
  SENIORITY_IDS_AT_MIGRATION,
  mapColumnSql,
  profileMoveSql,
  reverseMapColumnSql,
} from '../database/work-taxonomy-migration.sql';

/**
 * One migration, three changes, all part of the same work-taxonomy rework
 * (see `QUEERPULSE-WORK-TAXONOMY-DESIGN-2026-09-29.md`).
 *
 * 1. `jobs.category` moves from a free-form English label ("Design &
 *    creative") to a catalog id ("design"), the same id space
 *    `profiles.discipline` already uses. The column becomes nullable: a
 *    handful of legacy rows (English labels that never matched a current
 *    field, such as "Other" or "Practical help") have no honest id to fall
 *    back to, so `JobsService.update` treats a null category as
 *    "legacy, needs a field" and asks the poster to choose one on save.
 *    `jobs.commitment` and `jobs.seniority` get the same label-to-id
 *    treatment, and both keep a safe non-null default (`fullTime`,
 *    `anyLevel`) because every legacy value maps onto the new six/five-item
 *    id sets with no gap.
 * 2. `jobs.profession` is a new nullable column: a job can now name a single
 *    profession id inside its field, mirroring how `profiles.profession`
 *    narrows `profiles.discipline`. Every existing row gets `NULL` (no
 *    profession was ever collected before this).
 * 3. Nineteen professions move to a different field in today's taxonomy
 *    (research section 3.6: `securityGuard` retail -> security, and 18
 *    others). Any member profile holding one of those professions gets the
 *    new field appended to `profiles.discipline`, and loses the OLD field
 *    only when no OTHER profession still held by that profile belongs to it
 *    (`REMAINING_PROFESSIONS_BY_OLD_FIELD` in
 *    `src/database/work-taxonomy-migration.sql.ts` is the guard list). A
 *    member who is a `securityGuard` and nothing else in retail loses
 *    `retail` and gains `security`; a member who is also a `shopAssistant`
 *    keeps `retail` because `shopAssistant` still belongs there.
 *
 * Every mapping table (in `src/database/work-taxonomy-migration.sql.ts`,
 * kept out of this folder because TypeORM would instantiate its exported
 * helpers as migrations) is a literal, copied inline and kept independent
 * of `src/profiles/professions.ts` and `src/jobs/job-vocabulary.ts`: a
 * migration is frozen history and must keep working even after those files
 * change shape again later. `REMAINING_PROFESSIONS_BY_OLD_FIELD` was verified
 * against the taxonomy as it stands on 2026-09-29, current ids only (a
 * profession id introduced by a later taxonomy change cannot appear here,
 * by construction).
 */
export class WorkTaxonomyJobIdsAndFieldMoves1825100000000 implements MigrationInterface {
  name = 'WorkTaxonomyJobIdsAndFieldMoves1825100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ALTER COLUMN "category" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD COLUMN "profession" varchar NULL`,
    );
    await queryRunner.query(
      `UPDATE "jobs" SET "category" = ${mapColumnSql(
        '"category"',
        LEGACY_CATEGORY_TO_FIELD,
        JOB_FIELD_IDS_AT_MIGRATION,
        null,
      )}`,
    );
    await queryRunner.query(
      `UPDATE "jobs" SET "commitment" = ${mapColumnSql(
        '"commitment"',
        LEGACY_COMMITMENT_TO_ID,
        COMMITMENT_IDS_AT_MIGRATION,
        'fullTime',
      )}`,
    );
    await queryRunner.query(
      `UPDATE "jobs" SET "seniority" = ${mapColumnSql(
        '"seniority"',
        LEGACY_SENIORITY_TO_ID,
        SENIORITY_IDS_AT_MIGRATION,
        'anyLevel',
      )}`,
    );
    for (const statement of profileMoveSql()) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Field ids without a canonical legacy label (every job field beyond the
    // original seven categories, plus a null category) become 'Other': the
    // old frontend list always offered an 'Other' option, so this is a real
    // value that round-trips cleanly.
    await queryRunner.query(
      `UPDATE "jobs" SET "category" = ${reverseMapColumnSql(
        '"category"',
        FIELD_TO_LEGACY_CATEGORY,
        'Other',
      )}`,
    );
    await queryRunner.query(
      `UPDATE "jobs" SET "commitment" = ${reverseMapColumnSql(
        '"commitment"',
        LEGACY_COMMITMENT_LABEL_BY_ID,
        'Full-time',
      )}`,
    );
    await queryRunner.query(
      `UPDATE "jobs" SET "seniority" = ${reverseMapColumnSql(
        '"seniority"',
        LEGACY_SENIORITY_LABEL_BY_ID,
        'Any level',
      )}`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ALTER COLUMN "category" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "profession"`);

    // Profile field moves are not reversed: the old placement (for example
    // `securityGuard` under `retail`) was the error this migration fixes.
    // A profile that gained a field in `up()` simply keeps it.
  }
}
