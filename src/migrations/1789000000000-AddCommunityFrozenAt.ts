import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `communities.frozen_at` — the auto-freeze state set when a community with
 * `auto_freeze_on_reports` on takes an emergency report or crosses the open-report
 * pile-up threshold. A frozen community stays visible but blocks new joins and
 * new posts/replies from plain members until an owner/mod lifts it.
 *
 * Nullable `timestamptz`, so this is a metadata-only `ADD COLUMN` (no table
 * rewrite, safe online) — same shape as `1785800600000-AddCommunityArchivedAt`.
 */
export class AddCommunityFrozenAt1789000000000 implements MigrationInterface {
  name = 'AddCommunityFrozenAt1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "frozen_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "frozen_at"`,
    );
  }
}
