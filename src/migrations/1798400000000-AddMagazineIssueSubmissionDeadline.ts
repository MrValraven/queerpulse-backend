// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `magazine_issue.submission_deadline` (PRD-106): the last day the desk
 * accepts pitches for an issue.
 *
 * WHY THE COLUMN EXISTS. The public submit-story form printed
 * "Issue 26 · July 2026 · Submission deadline 15 August 2026" from a
 * hardcoded frontend constant. Nothing in the database said which issue was
 * open or when it closed, so the date could only ever be a guess that went
 * stale: by September 2026 every writer opening the form read a deadline
 * three weeks in the past on an issue number the desk had never created.
 *
 * Which issue is OPEN is derivable from data that already exists (the next
 * issue by `published_on` that has not shipped yet, see
 * `MagazineService.getOpenIssue`). The DEADLINE is not: an issue closes to
 * submissions well before it publishes, and by how much is an editorial
 * decision nobody has recorded anywhere. So this is one nullable `date`
 * column, matching `published_on`'s type and its NULL-means-unset contract.
 *
 * NULLABLE ON PURPOSE, with no backfill. Every existing issue gets NULL, and
 * the form renders no deadline line at all until an editor sets one on the
 * issue-production page. A fabricated default would put the platform right
 * back to quoting a date the desk never agreed to.
 *
 * Transactional: a single nullable `ADD COLUMN` takes no table rewrite and
 * builds no index.
 */
export class AddMagazineIssueSubmissionDeadline1798400000000 implements MigrationInterface {
  name = 'AddMagazineIssueSubmissionDeadline1798400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" ADD "submission_deadline" date`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" DROP COLUMN "submission_deadline"`,
    );
  }
}
