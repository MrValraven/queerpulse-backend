import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `communities.is_featured` — a platform-wide singleton flag an admin
 * sets from the community's Settings tab (`AdminCommunitiesService.updateSettings`)
 * to choose the one community the Communities Discover page's hero card shows.
 * "Singleton" is enforced in application code (the service clears every other
 * `true` row in the same transaction before setting a new one), not a DB
 * constraint — mirrors this schema's general posture of app-enforced
 * invariants over partial unique indexes for admin-only toggles.
 *
 * Defaults to `false` for every existing row, so no community starts featured.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCommunityFeaturedFlag1793200000000
  implements MigrationInterface
{
  name = 'AddCommunityFeaturedFlag1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "communities" ADD COLUMN "is_featured" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "communities" DROP COLUMN "is_featured"
    `);
  }
}
