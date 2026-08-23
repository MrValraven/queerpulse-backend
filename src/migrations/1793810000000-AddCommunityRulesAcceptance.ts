// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rules acceptance: a community's rules get a version, and each member records
 * which version they agreed to.
 *
 * `communities.rules_version` starts at 1 and is bumped by the owner-facing
 * update path when the rules change materially. That bump is the mechanism
 * that re-prompts the roster: agreement to v1 says nothing about v2, and
 * without a version there is no way to tell a member who accepted the current
 * rules from one who accepted rules that have since been rewritten.
 *
 * `community_members.rules_accepted_at` / `rules_version_accepted` are both
 * NULLABLE on purpose. Every member on a roster today joined before rules
 * acceptance existed, and backfilling them to the current version would record
 * a consent nobody gave. NULL reads as "never accepted", which is the honest
 * answer and the one that prompts them.
 *
 * `rules_version` is NOT NULL with a constant default, so `ADD COLUMN` is a
 * metadata-only change and every existing community reads as rules v1.
 */
export class AddCommunityRulesAcceptance1793810000000 implements MigrationInterface {
  name = 'AddCommunityRulesAcceptance1793810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "rules_version" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" ADD "rules_accepted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" ADD "rules_version_accepted" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP COLUMN "rules_version_accepted"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP COLUMN "rules_accepted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "rules_version"`,
    );
  }
}
