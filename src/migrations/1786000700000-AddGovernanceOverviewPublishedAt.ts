import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `governance_overview.published_at` (P3-7): a nullable timestamp marking
 * when an admin/moderator last **published** the singleton governance snapshot.
 * `null` until the first publish. Distinct from `updated_at` (which bumps on any
 * write) — publishing is the deliberate transparency-report act that the public
 * `GET /governance/overview` surfaces as a "last published" line, and the admin
 * `POST /governance/admin/publish` sets.
 */
export class AddGovernanceOverviewPublishedAt1786000700000
  implements MigrationInterface
{
  name = 'AddGovernanceOverviewPublishedAt1786000700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "governance_overview"
      ADD COLUMN "published_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "governance_overview" DROP COLUMN "published_at"
    `);
  }
}
