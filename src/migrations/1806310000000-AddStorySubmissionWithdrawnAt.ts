// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-129 — adds `magazine_story_submission.withdrawn_at`, the instant the
 * member who wrote a story pulled it back before the desk answered.
 *
 * Until now a member had no way out at all: once "Submit for review" was
 * pressed the story sat in the editorial queue until someone decided on it, and
 * a member who changed their mind (wrong draft, second thoughts about being
 * identifiable, a story about someone who has since asked them not to) could
 * only ask a human. The tracker at `/magazine/pitches` shows a Withdraw button
 * on every undecided submission and had nothing behind it.
 *
 * A soft mark rather than a delete, on purpose:
 *   - The row is evidence. A member who withdraws and later says the magazine
 *     published without consent, or an editor who half-read a story before it
 *     vanished, both need it to still exist.
 *   - `status` is a published contract shared verbatim with the frontend's
 *     `SubmissionStatus` (and a Postgres enum, `magazine_submission_status_enum`),
 *     and every client map keyed on it is exhaustive. Widening it would need an
 *     `ADD VALUE` here AND a matching arm in each of those maps, and a client
 *     that had not shipped the arm yet would render the raw machine value at
 *     the member. A separate nullable timestamp carries the same fact with no
 *     enum change and no client coupling.
 *   - The instant itself is worth keeping: "withdrawn" and "withdrawn four
 *     minutes after an editor opened it" are different conversations.
 *
 * Both read paths filter on it (`listMine` for the member,
 * `AdminStorySubmissionsService.list` for the desk), so a withdrawn story stops
 * appearing as awaiting an answer on either side. No index: neither query is
 * driven by this column (the member's is `user_id`, the desk's is an ordered
 * page over a small table), so it is a filter on an already-narrow result.
 */
export class AddStorySubmissionWithdrawnAt1806310000000 implements MigrationInterface {
  name = 'AddStorySubmissionWithdrawnAt1806310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" ADD COLUMN "withdrawn_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP COLUMN "withdrawn_at"`,
    );
  }
}
