// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A staff-only free-text note on a DECLINED platform join request, so the
 * reviewer who turned someone away can leave the context a closed-set
 * `decline_reason` key cannot carry ("same person as the March request, new
 * email"), and the next reviewer to meet a returning applicant can read it.
 *
 * One editable note per request, held on the row itself: three nullable
 * columns, no backfill, because every existing row simply has no note yet.
 *
 *  - `internal_note` is the text, stored as plain text by
 *    `JoinRequestsService.updateInternalNote` (markup stripped, trimmed, and
 *    NULL for blank).
 *  - `internal_note_updated_at` / `internal_note_updated_by` record the last
 *    edit, and are cleared together with the text when the note is emptied.
 *
 * `internal_note_updated_by` follows `reviewed_by` exactly: an FK to `users`
 * with ON DELETE SET NULL, so erasing a staff member never blocks on, or
 * deletes, a note they wrote, and an index so that erasure's SET NULL cascade
 * does not scan the table (the same reason `IDX_join_requests_reviewed_by`
 * exists).
 *
 * The note is NEVER applicant-facing: `toPublicJoinRequestStatusView`,
 * `toSubmittedJoinRequestView` and the member data export all map columns
 * explicitly and do not read these.
 */
export class AddJoinRequestInternalNote1828100000000 implements MigrationInterface {
  name = 'AddJoinRequestInternalNote1828100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "internal_note" text,
        ADD "internal_note_updated_at" TIMESTAMP WITH TIME ZONE,
        ADD "internal_note_updated_by" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD CONSTRAINT "FK_join_requests_internal_note_updated_by"
        FOREIGN KEY ("internal_note_updated_by") REFERENCES "users"("id")
        ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_join_requests_internal_note_updated_by"
        ON "join_requests" ("internal_note_updated_by")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_join_requests_internal_note_updated_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP CONSTRAINT "FK_join_requests_internal_note_updated_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "internal_note_updated_by",
        DROP COLUMN "internal_note_updated_at",
        DROP COLUMN "internal_note"
    `);
  }
}
