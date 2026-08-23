// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The owner's welcome note (`communities.welcome_message`) and the per-member
 * stamp that makes it show exactly once
 * (`community_members.welcome_seen_at`).
 *
 * Joining a community currently drops a new member into a feed with no
 * orientation, so owners paste a "start here" note into a pinned post that
 * nobody scrolls back to. This is that note, delivered at the one moment it is
 * read: the member's first visit after joining.
 *
 * Both columns are nullable. A NULL `welcome_message` means the community has
 * no welcome and the step is skipped entirely rather than shown empty. A NULL
 * `welcome_seen_at` means "not shown yet", so a member who joined before this
 * existed sees the welcome once on their next visit, which is the intended
 * behaviour and not a backfill gap.
 */
export class AddCommunityWelcomeMessage1793850000000 implements MigrationInterface {
  name = 'AddCommunityWelcomeMessage1793850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "welcome_message" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" ADD "welcome_seen_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP COLUMN "welcome_seen_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "welcome_message"`,
    );
  }
}
