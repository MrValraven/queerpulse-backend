// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listing_enquiries.owner_id` becomes nullable.
 *
 * A listing whose owner account was erased, or whose owner is suspended, keeps
 * working as a business mailbox while at least one active co-manager can
 * answer it: `ListingEnquiriesService` decides reachability from the
 * listing's staff, the same way persona and company mailboxes do. An enquiry
 * to an ownerless listing has no owner to record, so the column holds the
 * owner of record at send time when there is one and NULL otherwise.
 *
 * The column keeps its meaning as a snapshot with no foreign key
 * (`CreateListingEnquiries1794500000000` explains why), so nothing else
 * changes here: no index reads it and no constraint names it.
 *
 * `down()` REFUSES while NULL rows exist, deliberately. Each row is the record
 * that a member contacted a business, which is what makes an abuse report
 * about an enquiry investigable and what the daily caps count. Deleting those
 * rows to satisfy the constraint would erase that record, and writing some
 * other member's id into them would invent an owner who never received the
 * message. A maintainer who really needs the revert decides what to do with
 * those rows first; the error names how many there are.
 */
export class MakeListingEnquiryOwnerNullable1821500100000 implements MigrationInterface {
  name = 'MakeListingEnquiryOwnerNullable1821500100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_enquiries" ALTER COLUMN "owner_id" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [countRow] = (await queryRunner.query(
      `SELECT count(*)::int AS "ownerlessCount" FROM "listing_enquiries" WHERE "owner_id" IS NULL`,
    )) as Array<{ ownerlessCount: number }>;
    const ownerlessCount = countRow?.ownerlessCount ?? 0;
    if (ownerlessCount > 0) {
      throw new Error(
        `MakeListingEnquiryOwnerNullable1821500100000 cannot be reverted: ` +
          `${ownerlessCount} listing_enquiries row(s) have no owner_id. ` +
          `They record enquiries sent to ownerless listings; decide what ` +
          `happens to them before restoring NOT NULL.`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "listing_enquiries" ALTER COLUMN "owner_id" SET NOT NULL`,
    );
  }
}
