import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CON-01 — reader story submissions were a black hole. A member wrote a whole
 * piece at `/magazine/submit-story` and the platform kept only a concatenated
 * `pitch` blob, threw away the cover it had just charged them the upload for,
 * and offered staff a read-only list with no way to answer. This migration is
 * the storage half of the fix.
 *
 * On `magazine_story_submission`:
 *   - `deck` / `body` / `cover_image_key`: the parts of the piece, stored
 *     separately. Nullable, because every existing row predates the split and
 *     still carries deck+body concatenated in `pitch` — reading code falls
 *     back to `pitch` rather than assuming `body` is populated. That is the
 *     whole backwards-compatibility contract; no backfill is attempted,
 *     because splitting an old blob back apart would be guesswork.
 *   - `decision` / `decision_note` / `decided_by` / `decided_at`: the
 *     editorial verdict, mirroring `magazine_writer_applications`'
 *     `reviewed_by`/`review_note`/`reviewed_at`. `decision` is a plain
 *     `varchar` string union (`accepted | declined | commissioned`) rather
 *     than a second enum type: `status` is a published frontend contract and
 *     widening it would break every exhaustive map keyed on it.
 *   - `commissioned_pitch_id`: the `magazine_pitch` a commission created.
 *
 * On `magazine_pitch`:
 *   - `story_submission_id`: the submission a pitch was commissioned from, so
 *     the desk inbox can open the full piece the member actually wrote.
 *
 * Also adds `story_submission_decided` to `notifications_type_enum` — the bell
 * that tells the submitter. ADD VALUE only, never used in the same
 * transaction, so it is safe inside the migration transaction on PostgreSQL
 * 12+ (same precedent as `AddChangemakerNominationTriage1792500100000`).
 * `down()` cannot undo it; Postgres has no DROP VALUE.
 */
export class AddStorySubmissionDecision1794833100000 implements MigrationInterface {
  name = 'AddStorySubmissionDecision1794833100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "deck" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "body" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "cover_image_key" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "decision" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "decision_note" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "decided_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "decided_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "commissioned_pitch_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD CONSTRAINT "FK_magazine_story_submission_decided_by" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    // Postgres does not index a foreign-key column automatically, so without
    // this every hard delete of a `users` row (account erasure) would
    // sequentially scan this table to fix up the ON DELETE SET NULL.
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_story_submission_decided_by" ON "magazine_story_submission" ("decided_by")`,
    );

    await queryRunner.query(
      `ALTER TABLE "magazine_pitch" ADD "story_submission_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_pitch" ADD CONSTRAINT "FK_magazine_pitch_story_submission" FOREIGN KEY ("story_submission_id") REFERENCES "magazine_story_submission"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_pitch_story_submission" ON "magazine_pitch" ("story_submission_id")`,
    );

    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'story_submission_decided'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No-op for the notification-type value: Postgres cannot drop an enum
    // value, and the added label is harmless if left in place.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_magazine_pitch_story_submission"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_pitch" DROP CONSTRAINT "FK_magazine_pitch_story_submission"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_pitch" DROP COLUMN "story_submission_id"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_magazine_story_submission_decided_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP CONSTRAINT "FK_magazine_story_submission_decided_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "commissioned_pitch_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "decided_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "decided_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "decision_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "decision"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "cover_image_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "body"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "deck"`,
    );
  }
}
