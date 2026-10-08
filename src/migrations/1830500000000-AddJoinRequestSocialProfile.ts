import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an optional social profile to platform join requests.
 *
 * The applicant may share a handle or a link (Instagram, TikTok, Bluesky or
 * anything else) so a reviewer can check that someone nobody here knows is a
 * genuine person who means the community well. Self-reported, staff-only, and
 * never validated as a URL because a plain handle is welcome.
 *
 * Nullable with no default and no backfill: it is optional going forward and
 * every earlier row simply has none.
 */
export class AddJoinRequestSocialProfile1830500000000 implements MigrationInterface {
  name = 'AddJoinRequestSocialProfile1830500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "social_profile" character varying(200)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "social_profile"
    `);
  }
}
