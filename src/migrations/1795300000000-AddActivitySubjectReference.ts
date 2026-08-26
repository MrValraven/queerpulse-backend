import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Profile activity rows gain a subject reference, plus two new kinds.
 *
 * `subject_kind` / `subject_id` let the read path re-check that a row's
 * subject is STILL public before showing or linking it. The write-time gate in
 * `ActivityListener` only knows the subject's visibility at the instant of the
 * action; a public event can be switched to members-only, a public community
 * to request-to-join, and a published persona unpublished, at which point the
 * row must stop being served. See `ActivitySubjectKind` and
 * `ActivityVisibilityService`.
 *
 * Both columns are nullable, and every existing row keeps `null`: rows written
 * before this migration are treated as unverifiable and keep their original
 * behaviour (shown, never linked).
 *
 * `community` and `persona` join `activities_kind_enum` for the two new
 * listeners (a public community join, a persona publish).
 */
export class AddActivitySubjectReference1795300000000 implements MigrationInterface {
  name = 'AddActivitySubjectReference1795300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new values are not USED in this same
    // transaction — nothing below writes a row with either label.
    await queryRunner.query(
      `ALTER TYPE "activities_kind_enum" ADD VALUE IF NOT EXISTS 'community'`,
    );
    await queryRunner.query(
      `ALTER TYPE "activities_kind_enum" ADD VALUE IF NOT EXISTS 'persona'`,
    );
    await queryRunner.query(
      `CREATE TYPE "activities_subject_kind_enum" AS ENUM ('event', 'community', 'persona')`,
    );
    await queryRunner.query(
      `ALTER TABLE "activities" ADD "subject_kind" "activities_subject_kind_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "activities" ADD "subject_id" character varying`,
    );
    // The purge deletes every row pointing at one subject across all members,
    // so it looks rows up by (kind, id), never by user.
    await queryRunner.query(
      `CREATE INDEX "IDX_activities_subject" ON "activities" ("subject_kind", "subject_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_activities_subject"`);
    await queryRunner.query(
      `ALTER TABLE "activities" DROP COLUMN "subject_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "activities" DROP COLUMN "subject_kind"`,
    );
    await queryRunner.query(`DROP TYPE "activities_subject_kind_enum"`);
    // The two `activities_kind_enum` labels stay: Postgres has no
    // `ALTER TYPE ... DROP VALUE`, and leaving them is harmless (no row can
    // reference them once the listeners writing them are gone). Rebuilding the
    // enum without them is a manual, backup-shaped operation.
  }
}
