import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CON-18 — money out of `varchar` and into `numeric`.
 *
 * `magazine_payment.fee` and `expenses` were free text, so the desk could
 * record a fee but never total one: "what did issue 09 cost" had no answer.
 * There was also no currency column, so "250" meant whatever the editor
 * happened to be thinking of.
 *
 * This migration only moves the SHAPE, and it does it without touching a
 * single stored byte:
 *  - `fee` -> `fee_text`, `expenses` -> `expenses_text`. A rename preserves
 *    every existing value exactly, where an in-place `ALTER TYPE ... USING`
 *    would have to guess at "EUR 250" and drop what it could not read.
 *  - `fee_amount`/`expenses_amount` arrive EMPTY as `numeric(12,2)`.
 *  - `currency` arrives as ISO 4217, defaulting to EUR (the magazine prices
 *    in euros; a row in anything else says so explicitly).
 *
 * The values are read across in `BackfillMagazinePaymentAmounts`, which runs
 * next and never deletes the text it parsed. `fee_text` also loses its NOT
 * NULL: once the amount is the real field, a payment can carry a price and no
 * prose at all.
 *
 * `invoice` is deliberately left alone. It holds an invoice REFERENCE
 * ("INV-2026-084"), never a sum, and belongs in no total.
 */
export class AddMagazinePaymentNumericMoney1794833700000 implements MigrationInterface {
  name = 'AddMagazinePaymentNumericMoney1794833700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" RENAME COLUMN "fee" TO "fee_text"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" RENAME COLUMN "expenses" TO "expenses_text"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" ALTER COLUMN "fee_text" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" ADD "currency" character varying(3) NOT NULL DEFAULT 'EUR'`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" ADD "fee_amount" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" ADD "expenses_amount" numeric(12,2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" DROP COLUMN "expenses_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" DROP COLUMN "fee_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" DROP COLUMN "currency"`,
    );
    // The original column was NOT NULL, and a row created after this
    // migration may legitimately have no fee prose at all. Empty string is
    // what `upsertPayment` used to write for "no fee stated", so the revert
    // restores that rather than failing on the constraint.
    await queryRunner.query(
      `UPDATE "magazine_payment" SET "fee_text" = '' WHERE "fee_text" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" ALTER COLUMN "fee_text" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" RENAME COLUMN "expenses_text" TO "expenses"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_payment" RENAME COLUMN "fee_text" TO "fee"`,
    );
  }
}
