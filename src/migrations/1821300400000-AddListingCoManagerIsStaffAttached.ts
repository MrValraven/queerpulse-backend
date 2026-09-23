// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records which co-manager seats staff attached to an UNOWNED listing.
 *
 * `ListingCoManagersService.revokeAllForOwnershipTransfer` clears every live
 * seat when a listing changes hands, on the grounds that the seats belong to
 * the owner who appointed them and leave with that owner. Staff attaching a
 * co-manager to a listing that has no owner are doing the opposite thing: the
 * seat exists FOR the incoming owner, so it has to survive the handover.
 *
 * `owner_id` being null is too weak a signal to tell those apart, because
 * `SetNullContentAuthorFksOnUserErasure1794610000000` also nulls it when an
 * owner erases their account, leaving that owner's appointees behind on a
 * listing `assertClaimable` will hand to a claimant. The provenance is
 * therefore stored on the seat itself.
 *
 * `NOT NULL DEFAULT false` means every existing seat keeps today's behaviour
 * exactly: it was appointed by an owner, so a transfer still revokes it.
 */
export class AddListingCoManagerIsStaffAttached1821300400000 implements MigrationInterface {
  name = 'AddListingCoManagerIsStaffAttached1821300400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_co_managers" ADD "is_staff_attached" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_co_managers" DROP COLUMN "is_staff_attached"`,
    );
  }
}
