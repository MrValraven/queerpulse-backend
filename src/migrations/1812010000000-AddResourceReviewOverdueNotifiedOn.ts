// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-270 — adds `resources.review_overdue_notified_on`, the date staff were
 * last told this guide is waiting for an editorial review.
 *
 * Guide review had an operator page and no reminder. `review_due_on` was
 * written, indexed and sorted on, and nothing ever read it on a clock: no
 * cron, no bell, no queue. A guide with no `last_reviewed_on` is not merely
 * stale either, it is INVISIBLE — `ResourcesService` requires
 * `last_reviewed_on IS NOT NULL` on every public read — so a harm-reduction
 * or trans-healthcare page could sit unpublished for months unless a curator
 * happened to open /admin/resource-guides unprompted.
 *
 * `ResourceReviewSweeperService` now runs daily and announces the guides that
 * have come due into the `guide_reviews` admin queue. This column is what
 * makes that announcement fire ONCE per overdue period instead of every
 * morning forever:
 *
 *  - NULL means nobody has been told about this guide's current review debt.
 *  - A date means they have. The sweep re-announces only when the guide goes
 *    overdue AGAIN, which it detects as `review_due_on > review_overdue_notified_on`:
 *    a stamped review pushes the due date forward, so the next lapse is a new
 *    fact rather than the same one repeated.
 *  - `AdminResourcesService.review` clears it back to NULL when a guide is
 *    actually reviewed, so the cycle restarts cleanly even if the new due date
 *    happens to fall before the old notification.
 *
 * A `date`, not a timestamp, to match `review_due_on` and `last_reviewed_on`
 * beside it: the comparison this column exists for is day-grained, and a
 * timestamptz would invite a timezone question that has no bearing on whether
 * a guide is overdue.
 *
 * NO INDEX. The sweep's driving predicate is `review_due_on`, which already
 * carries `IDX_resources_review_due_on`; this column is a filter applied to
 * the handful of rows that survive it, on a table holding roughly thirty
 * guides.
 */
export class AddResourceReviewOverdueNotifiedOn1812010000000
  implements MigrationInterface
{
  name = 'AddResourceReviewOverdueNotifiedOn1812010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "resources" ADD COLUMN "review_overdue_notified_on" date`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "resources" DROP COLUMN "review_overdue_notified_on"`,
    );
  }
}
