import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two `notifications_type_enum` values backing the (forthcoming)
 * XP/badge awarding engine: `xp_level_up` (a member crosses an XP level
 * threshold) and `badge_earned` (a member is granted a badge). Both are
 * system-driven, no-actor notifications, like `VerificationUpdate`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. AddVerificationUpdateNotificationType): `ALTER TYPE ...
 * ADD VALUE` must be COMMITTED before any statement may use the new label,
 * so this opts out of the wrapping transaction (`transaction = false`,
 * honoured because `data-source.ts` sets `migrationsTransactionMode:
 * 'each'`). `IF NOT EXISTS` keeps it re-run-safe. `down()` is a no-op:
 * Postgres has no `ALTER TYPE ... DROP VALUE`, and the added labels are
 * harmless if left.
 */
export class AddRecognitionNotificationTypes1789600000000 implements MigrationInterface {
  name = 'AddRecognitionNotificationTypes1789600000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'xp_level_up'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'badge_earned'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added values are harmless.
  }
}
