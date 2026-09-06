// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-269 — adds `resource_suggestion.created_listing_id`, the directory row
 * an approval actually produced.
 *
 * Approving a member's resource suggestion used to flip a status and tell the
 * member their resource was accepted, and that was the whole transition. The
 * organisation itself only reached the public Legal Aid / Sexual Health
 * Testing directory if somebody later remembered to retype it by hand in the
 * separate listings console. The member had been told "accepted" either way,
 * and the second, hand-keyed entry is exactly where a wrong digit in a legal
 * clinic's phone number comes from.
 *
 * Approval now creates the listing in the same transaction as the status
 * flip, and this column is the link between the two halves. It carries two
 * jobs:
 *
 *  - It is the DUPLICATE GUARD. A second approve on the same row (a
 *    double-click, a retried request, two curators on the same queue) finds
 *    this column already populated and is refused rather than publishing the
 *    same clinic twice. The partial unique index below makes that guarantee
 *    hold at the database rather than only in the service, so two concurrent
 *    approvals cannot both win the check and both write.
 *  - It is the audit trail. "Which suggestion is this listing?" and "did this
 *    approval ever produce anything?" are both questions the queue could not
 *    answer before.
 *
 * NULLABLE, and it stays nullable forever: every suggestion decided before
 * this migration was approved under the old hand-entry rule, and inventing a
 * link for those rows would claim a provenance nobody recorded. A declined or
 * archived suggestion never has one either.
 *
 * NO FOREIGN KEY, deliberately, matching `resource_suggestion.decided_by` and
 * `resource_listing.created_by` on the same pair of tables. A listing that
 * closes down is deleted outright by `AdminResourceListingsService.remove`,
 * and the record that this suggestion was once approved and published must
 * outlive that deletion: `ON DELETE CASCADE` would erase the decision, and
 * `ON DELETE SET NULL` would silently re-open the duplicate guard on a row a
 * curator had already dealt with.
 */
export class AddResourceSuggestionCreatedListing1812000000000
  implements MigrationInterface
{
  name = 'AddResourceSuggestionCreatedListing1812000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "resource_suggestion" ADD COLUMN "created_listing_id" uuid`,
    );
    // Partial: only populated rows participate, so the thousands of pending,
    // declined and archived suggestions carrying NULL do not collide with one
    // another. One listing can be the product of at most one approval.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_resource_suggestion_created_listing_id" ` +
        `ON "resource_suggestion" ("created_listing_id") ` +
        `WHERE "created_listing_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_resource_suggestion_created_listing_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "resource_suggestion" DROP COLUMN "created_listing_id"`,
    );
  }
}
