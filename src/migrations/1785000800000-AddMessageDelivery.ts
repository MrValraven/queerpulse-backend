import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMessageDelivery1785000800000 implements MigrationInterface {
  name = 'AddMessageDelivery1785000800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Delivered receipt as a PER-PARTICIPANT WATERMARK, deliberately mirroring
    // the existing `last_read_at` watermark on the same table rather than a
    // per-message `messages.delivered_at` column:
    //   - Symmetry: "read" is already a watermark here ("this participant has
    //     read everything up to X"); "delivered" is the same shape one rung
    //     lower ("…has received everything up to X"). The frontend derives both
    //     the same way (`lastOutbound.at <= counterpartWatermark`).
    //   - Cost: O(participants), not O(messages) — one column, one row per
    //     participant, updated in place. The delivered ack is a single
    //     "received up to now()" stamp the recipient batches, not an N-row write.
    //   - It composes with `last_read_at`: read implies delivered, so `markRead`
    //     advances both, and read (seen) simply outranks delivered when rendered.
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" ADD "delivered_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP COLUMN "delivered_at"`,
    );
  }
}
