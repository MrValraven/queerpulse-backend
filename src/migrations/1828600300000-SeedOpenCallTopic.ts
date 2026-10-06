// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Funding & Grants (P3): seeds the "Open funding calls" topic, keyed on the
 * server-owned `open-call` tag that `ForumThreadsService` puts on every open
 * call. The existing topic link (`TopicPostLinkService.linkThread`) and
 * `TopicFollowNotificationsListener` then tell its followers about each new
 * call with `topic_new_post`; nothing new listens.
 *
 * A data migration for the reason `SeedTopics1794701000000` gives: the dev
 * seed refuses production. The row lives here (and not in `topics.seed.ts`),
 * because that file documents that new topics are added outside it and its
 * migration never runs again.
 *
 * The follow key is the TAG (`topic_follows.topic_slug` stores `topics.tag`),
 * so members follow it at `POST /topics/open-call/follow`. The label is the
 * English one; the Portuguese title is frontend copy.
 *
 * Idempotent through `ON CONFLICT ("tag") DO NOTHING`, so an admin's later
 * edit to the row survives a re-run.
 *
 * `up` also strips `open-call` from every thread that is not a call. Before
 * this build the tag was free text, so a member may already have typed it on
 * an ordinary thread, which would then list under the new topic. The service
 * strips it from every non-call from now on; this clears the rows written
 * before. `down` leaves the tags alone: the stripped values were never the
 * server's to restore.
 */
const OPEN_CALL_TOPIC = {
  tag: 'open-call',
  label: 'Open funding calls',
  description:
    'Grants, residencies, prizes and other open calls for queer work in Portugal and beyond, posted by members. Follow to hear about every new call.',
  isCrisisCard: false,
};

export class SeedOpenCallTopic1828600300000 implements MigrationInterface {
  name = 'SeedOpenCallTopic1828600300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "topics" ("tag", "label", "description", "crisis_card")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("tag") DO NOTHING`,
      [
        OPEN_CALL_TOPIC.tag,
        OPEN_CALL_TOPIC.label,
        OPEN_CALL_TOPIC.description,
        OPEN_CALL_TOPIC.isCrisisCard,
      ],
    );
    // The topic lists threads by tag, so a member-typed `open-call` on a
    // thread that is no call would read as one. `IS DISTINCT FROM` covers
    // unclassified threads (`kind` NULL) too. The `@>` guard can use the GIN
    // index on "tags" (`IDX_forum_thread_tags`), so only tagged rows are read.
    await queryRunner.query(
      `UPDATE "forum_thread"
          SET "tags" = array_remove("tags", 'open-call')
        WHERE "kind" IS DISTINCT FROM 'call'
          AND "tags" @> ARRAY['open-call']::text[]`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // `topic_post` rows cascade with the topic (`FK_topic_post_topic_id`).
    await queryRunner.query(`DELETE FROM "topics" WHERE "tag" = $1`, [
      OPEN_CALL_TOPIC.tag,
    ]);
  }
}
