import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `vouches.reactivated_at`: when a WITHDRAWN vouch was last brought back.
 *
 * The daily vouch cap counts rows whose `created_at` falls in the current UTC
 * day. Re-vouching updates the existing `(voucher_id, vouchee_id)` row in place
 * and keeps its original `created_at`, so a withdraw-and-re-vouch cycle never
 * counted against the cap: a member could withdraw and re-vouch the same person
 * unlimited times, and, once they had a row for someone, hand out fresh
 * "vouched today" notifications for free.
 *
 * With this column the cap counts `COALESCE(reactivated_at, created_at)`, so a
 * reactivation costs a slot exactly like a first vouch does. NULL means the
 * vouch has never been withdrawn and reinstated, which is the state every
 * existing row is in as far as we can reconstruct it, so no backfill is needed
 * or possible.
 *
 * Nullable timestamptz, no index: the cap query is already narrowed to one
 * `voucher_id` by the leading column of `UQ_vouches_voucher_vouchee`, and the
 * handful of rows that survives is filtered in memory.
 */
export class AddVouchReactivatedAt1793600000000 implements MigrationInterface {
  name = 'AddVouchReactivatedAt1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vouches" ADD "reactivated_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vouches" DROP COLUMN "reactivated_at"`,
    );
  }
}
