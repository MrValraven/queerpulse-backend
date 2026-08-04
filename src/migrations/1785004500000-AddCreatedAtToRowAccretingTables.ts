// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §B/P3 audit fix: ~15 row-accreting (append/content/log) tables never got a
 * `created_at`, so there was no way to do time-based retention, cohorting, or
 * "when did this row appear" debugging. This backfills one on each.
 *
 * `NOT NULL DEFAULT now()` matches the repo's convention (every other
 * `@CreateDateColumn` maps to `timestamptz NOT NULL DEFAULT now()`); existing
 * rows adopt the migration run-time as their creation instant — imprecise but
 * strictly better than a perpetual NULL, and correct for every row inserted
 * afterwards. Only genuine append/content tables are touched here; singleton /
 * settings / aggregate tables (member_preferences, platform_settings,
 * governance_overview, roadmap_settings, recognition_stats, email_preference,
 * changemaker_directory_settings) and tables that already carry a semantic
 * creation timestamp (account_deactivation.deactivated_at,
 * data_export_job.requested_at, activities.occurred_at,
 * cinema_watch_progress.updated_at) are deliberately left alone.
 */
export class AddCreatedAtToRowAccretingTables1785004500000 implements MigrationInterface {
  name = 'AddCreatedAtToRowAccretingTables1785004500000';

  private readonly tables: readonly string[] = [
    'community_post_reactions',
    'forum_post_vote',
    'company_team_members',
    'volunteer_opportunity_team',
    'event_cohosts',
    'board_posts',
    'group_memberships',
    'groups',
    'profile_featured_communities',
    'shapings',
    'skills',
    'social_links',
    'work_items',
    'subprofile_items',
    'subprofile_social_links',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const tableName of this.tables) {
      await queryRunner.query(
        `ALTER TABLE "${tableName}" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tableName of [...this.tables].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${tableName}" DROP COLUMN "created_at"`,
      );
    }
  }
}
