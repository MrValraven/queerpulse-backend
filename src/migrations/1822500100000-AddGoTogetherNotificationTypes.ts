// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

const NEW_TYPES = [
  'go_together_pair_invite',
  'go_together_group_ready',
  'go_together_unmatched',
  'go_together_member_left',
  'go_together_meet_again',
  'go_together_mutual',
];

/**
 * Adds the six Go together notification types to `notifications_type_enum`.
 * Runs outside the wrapping transaction (`data-source.ts` sets
 * `migrationsTransactionMode: 'each'`): a new label must be committed before any
 * statement may use it.
 */
export class AddGoTogetherNotificationTypes1822500100000 implements MigrationInterface {
  name = 'AddGoTogetherNotificationTypes1822500100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const notificationType of NEW_TYPES) {
      await queryRunner.query(
        `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS '${notificationType}'`,
      );
    }
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
