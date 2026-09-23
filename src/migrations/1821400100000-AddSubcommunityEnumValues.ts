// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSubcommunityEnumValues1821400100000 implements MigrationInterface {
  name = 'AddSubcommunityEnumValues1821400100000';
  // ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "communities_frozen_reason_enum" ADD VALUE IF NOT EXISTS 'parent_frozen'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'subcommunity_created'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'subcommunity_tier_raised'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error('Irreversible: Postgres cannot drop enum values.');
  }
}
