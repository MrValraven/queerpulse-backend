// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TRANSACTIONAL: safe inside the default wrapping transaction only because
 * nothing in this file uses the new label.
 */
export class AddListingOwnerOfferNotificationType1821300300000 implements MigrationInterface {
  name = 'AddListingOwnerOfferNotificationType1821300300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_owner_offer'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
