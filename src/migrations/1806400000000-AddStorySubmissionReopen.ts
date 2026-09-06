// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A declined story submission was a dead end. `decide` guards its claim on
 * `decided_at IS NULL` and answers a second decision with a 409, so a decline
 * could never be taken back: an editor who pressed the wrong button, changed
 * their mind, or read a revision the member sent afterwards had no route
 * except to ask the member to file the whole story again.
 *
 * `AdminStorySubmissionsService.reopen` is the route back, and it works by
 * CLEARING the decision (`decision`, `decision_note`, `decided_by`,
 * `decided_at` all back to NULL, `status` back to `submitted`), because that
 * is the only shape `list` puts back in the queue. These three columns are
 * what stops that erasure from being invisible:
 *
 *  - `reopened_by` — the staff member who took the decline back. FK to `users`
 *    with `ON DELETE SET NULL` and its own index, mirroring `decided_by`
 *    exactly: deleting a staff account must not delete a member's submission,
 *    and Postgres does not index a foreign-key column on its own, so without
 *    the index every `users` delete would sequentially scan this table.
 *  - `reopened_at` — when. Nullable with no default: NULL means "never
 *    reopened", which is every row written before this one and the
 *    overwhelming majority afterwards.
 *  - `reopen_count` — how many times, because the two columns above only ever
 *    hold the LAST reopen. A story that has been declined and reopened three
 *    times is a different conversation from one reopened once. NOT NULL
 *    DEFAULT 0, so existing rows read as never reopened rather than unknown.
 *
 * Stamped columns rather than a submission-history table, following
 * `withdrawn_at` (PRD-129) and for the same reason: this table records the
 * state of one submission, and the desk's real audit trail
 * (`magazine_piece_event`) is keyed on a piece, which a declined submission
 * does not have.
 *
 * No enum work: `status` moves back to `submitted`, a value the
 * `magazine_submission_status_enum` type already holds, and `decision` is a
 * plain nullable `varchar` string union.
 */
export class AddStorySubmissionReopen1806400000000 implements MigrationInterface {
  name = 'AddStorySubmissionReopen1806400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "reopened_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "reopened_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "reopen_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD CONSTRAINT "FK_magazine_story_submission_reopened_by" FOREIGN KEY ("reopened_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_story_submission_reopened_by" ON "magazine_story_submission" ("reopened_by")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_magazine_story_submission_reopened_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP CONSTRAINT "FK_magazine_story_submission_reopened_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "reopen_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "reopened_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "reopened_by"`,
    );
  }
}
