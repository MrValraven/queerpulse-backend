// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A community ban can now end by the clock (`community_bans.expires_at`).
 *
 * Until now a community ban was permanent by construction: there was no column
 * that could hold an end date, so the only sanction short of "never come back"
 * was no sanction at all. A moderator dealing with someone having a bad week
 * had to choose between doing nothing and removing them for life.
 *
 * NULL keeps its existing meaning: permanent. Every row that predates this
 * migration is therefore unchanged in effect, which is why the column is added
 * nullable with no default and no backfill.
 *
 * `IDX_community_bans_expires_at` is partial (`WHERE expires_at IS NOT NULL`).
 * Timed bans are the small minority of rows and the only ones any expiry
 * predicate has to look at, so a partial index stays small and never has to
 * carry the permanent bans. The join gate reads
 * `(expires_at IS NULL OR expires_at > now())` scoped to one (community, user)
 * pair, which the existing unique index already serves; this one is for the
 * sweeps that ask "which bans have run out".
 *
 * `CREATE INDEX` (not CONCURRENTLY) so the file stays transactional, matching
 * `AddCommunityBans1793800000000`. `community_bans` is a small table.
 */
export class AddCommunityBanExpiry1794910000000 implements MigrationInterface {
  name = 'AddCommunityBanExpiry1794910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "community_bans"
        ADD COLUMN "expires_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_community_bans_expires_at"
        ON "community_bans" ("expires_at")
        WHERE "expires_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_community_bans_expires_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "community_bans" DROP COLUMN "expires_at"
    `);
  }
}
