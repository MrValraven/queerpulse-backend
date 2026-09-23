// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TRANSACTIONAL: safe inside the default wrapping transaction only because
 * nothing in this file uses the new label. A migration that both adds an
 * enum value and writes a row carrying it has to split across two.
 */
export class AddListingStaffCreatedAction1821300200000 implements MigrationInterface {
  name = 'AddListingStaffCreatedAction1821300200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'staff_created'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
