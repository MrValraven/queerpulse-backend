// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keyset indexes for the admin platform log (`GET /admin/log`). Each listed
 * table is paged globally by its time column, newest first, with the row id
 * as tie-breaker; none of them had an index leading with that time column.
 * Built CONCURRENTLY so live writes to these tables are never blocked.
 */
const PLATFORM_LOG_TIME_INDEXES: ReadonlyArray<{
  name: string;
  table: string;
  timeColumn: string;
}> = [
  {
    name: 'IDX_vouches_created_at_id',
    table: 'vouches',
    timeColumn: 'created_at',
  },
  {
    name: 'IDX_community_members_joined_at_id',
    table: 'community_members',
    timeColumn: 'joined_at',
  },
  {
    name: 'IDX_join_requests_created_at_id',
    table: 'join_requests',
    timeColumn: 'created_at',
  },
  {
    name: 'IDX_verification_events_created_at_id',
    table: 'verification_events',
    timeColumn: 'created_at',
  },
  {
    name: 'IDX_safe_space_decision_audits_created_at_id',
    table: 'safe_space_decision_audits',
    timeColumn: 'created_at',
  },
  {
    name: 'IDX_listing_moderation_events_created_at_id',
    table: 'listing_moderation_events',
    timeColumn: 'created_at',
  },
];

export class AddPlatformLogTimeIndexes1828500000000 implements MigrationInterface {
  name = 'AddPlatformLogTimeIndexes1828500000000';

  // CONCURRENTLY cannot run inside a transaction block; `migrationsTransactionMode:
  // 'each'` (data-source.ts) lets this migration opt out on its own.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of PLATFORM_LOG_TIME_INDEXES) {
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY "${index.name}" ` +
          `ON "${index.table}" ("${index.timeColumn}" DESC, "id" DESC)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const index of [...PLATFORM_LOG_TIME_INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY "${index.name}"`);
    }
  }
}
