// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-124 — accepting a reader's story used to stamp `status = accepted`, ring
 * the member, and create nothing. The reader was told the magazine had taken
 * their piece while the desk got no piece row, no editor, no article draft and
 * no payment row, and because a decision is final the story could never be
 * commissioned afterwards either: the only route onto the desk was to retype
 * it out of the admin row.
 *
 * `accepted_piece_id` is the storage half of the fix: the `magazine_piece` an
 * acceptance created. It mirrors `commissioned_pitch_id` (the pitch a
 * COMMISSION creates) on the same row, so both yeses record what they left
 * behind and the admin surface can link through to either.
 *
 * The direction is submission -> piece rather than piece -> submission because
 * the admin story-submission list is the surface that has to show the link,
 * and it already loads this row: one nullable column serves it with no join.
 * A piece's own provenance is recorded where the desk reads provenance, in its
 * `magazine_piece_event` audit trail (`commissioned` / "from reader
 * submission").
 *
 * `ON DELETE SET NULL`, matching `decided_by`: deleting a desk piece must not
 * delete the member's submission or the decision recorded on it. The index is
 * there because Postgres does not index a foreign-key column automatically,
 * so without it every `magazine_piece` delete would sequentially scan this
 * table to fix the column up.
 */
export class AddStorySubmissionAcceptedPiece1806000000000 implements MigrationInterface {
  name = 'AddStorySubmissionAcceptedPiece1806000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD "accepted_piece_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD CONSTRAINT "FK_magazine_story_submission_accepted_piece" FOREIGN KEY ("accepted_piece_id") REFERENCES "magazine_piece"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_story_submission_accepted_piece" ON "magazine_story_submission" ("accepted_piece_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_magazine_story_submission_accepted_piece"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP CONSTRAINT "FK_magazine_story_submission_accepted_piece"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "accepted_piece_id"`,
    );
  }
}
