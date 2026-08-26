import { MigrationInterface, QueryRunner } from 'typeorm';
import { topicsSeed } from '../topics/topics.seed';

/**
 * Populates `topics` with the curated starter directory in every environment
 * (SOC-01).
 *
 * WHY A DATA MIGRATION RATHER THAN THE DEV SEED. `src/database/seed.ts`
 * refuses to run under `NODE_ENV=production`, so nothing has ever inserted a
 * topic row outside a developer's laptop. `/topics` and `/topic/:tag` are in
 * the meganav and in global search, and the follow API works, so in production
 * the directory rendered its empty state and every topic page 404'd. Same
 * reasoning and same shape as `SeedGovernanceContent1788600000000` and
 * `SeedModResponseTemplates1794621000000`.
 *
 * SINGLE SOURCE OF THE COPY. The rows come from `../topics/topics.seed.ts`
 * rather than being transcribed here, so the words cannot drift between the
 * two files. That file explains why these five topics are the editorial set.
 *
 * COUNTERS START AT ZERO. `total_posts` and `follower_count` keep their column
 * defaults. The demo fixture's headline numbers ("347 posts", "1.2k
 * following") are prototype dressing, and seeding them would print a count no
 * post or follow backs up. `follower_count` is maintained for real from here
 * on by `TopicFollowsService.follow`/`unfollow`.
 *
 * IDEMPOTENT. `ON CONFLICT ("tag") DO NOTHING` against `UQ_topics_tag`, so
 * re-running never duplicates a topic and never overwrites an edit an admin
 * has already made to one through `admin-topics`.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class SeedTopics1794701100000 implements MigrationInterface {
  name = 'SeedTopics1794701100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const topic of topicsSeed) {
      await queryRunner.query(
        `INSERT INTO "topics" ("tag", "label", "description", "crisis_card")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("tag") DO NOTHING`,
        [topic.tag, topic.label, topic.description, topic.isCrisisCard],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Removes only the tags this migration inserted. A topic the operating
    // team created afterwards is left alone. `topic_post` rows cascade with
    // their topic (`FK_topic_post_topic_id`), which is the correct revert:
    // those posts only exist under a seeded topic.
    await queryRunner.query(`DELETE FROM "topics" WHERE "tag" = ANY($1)`, [
      topicsSeed.map((topic) => topic.tag),
    ]);
  }
}
