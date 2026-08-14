import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two community safety-policy flags edited from the admin community
 * detail's Settings tab: `requires_second_vouch` and `auto_freeze_on_reports`.
 *
 * Both are `boolean NOT NULL DEFAULT false`. Since Postgres 11 a NOT NULL
 * column with a constant default is a metadata-only `ADD COLUMN` — the whole
 * table is not rewritten and no long lock is taken — so this is safe to run
 * online without `transaction = false`, matching the `AddCommunityArchivedAt`
 * precedent for adding a column to `communities`.
 */
export class AddCommunitySafetyPolicies1788900000000 implements MigrationInterface {
  name = 'AddCommunitySafetyPolicies1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "requires_second_vouch" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "auto_freeze_on_reports" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "auto_freeze_on_reports"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "requires_second_vouch"`,
    );
  }
}
