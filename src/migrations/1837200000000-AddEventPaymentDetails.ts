// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Event payment details: `payment_url` (an https link the host pastes, such
 * as Revolut, PayPal or Ko-fi) and `payment_instructions` (the host's own
 * words on how to pay) on `events`, both nullable varchar(500). Display only,
 * like `cost`: the platform takes no money and nothing reads these but the
 * event detail. Existing rows stay null, so no backfill and no index.
 */
export class AddEventPaymentDetails1837200000000 implements MigrationInterface {
  name = 'AddEventPaymentDetails1837200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "events"
        ADD COLUMN "payment_url" varchar(500) NULL,
        ADD COLUMN "payment_instructions" varchar(500) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "events"
        DROP COLUMN "payment_instructions",
        DROP COLUMN "payment_url"
    `);
  }
}
