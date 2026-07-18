import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives `topic_post` an author *user id*, closing the one content surface that
 * could not be block/mute filtered server-side.
 *
 * `1782800540000-AddTopicPosts` created this table as a seeded, frontend-mock
 * derived read model, so it stored only denormalized display strings
 * (`author_name` / `author_initials` / `author_tone`). `BlockFilterService`
 * keys everything off user ids, so there was no column to filter against, and
 * `TopicsService.listPosts` was left as the only post list in the app without
 * `excludeHidden` — documented as a known gap in its docstring. Forum,
 * communities, events and notifications all filter; this one did not.
 *
 * Three deliberate choices, mirroring what
 * `1782800700000-AddDeletionErasureSupport` did for `reports.reporter_id` and
 * `mod_audit_logs.actor_id`:
 *
 * 1. **NULLABLE.** Every existing row is seed editorial content with no member
 *    behind it. A `NOT NULL` column would force us to invent an attribution
 *    for each seed post — see (3).
 *
 * 2. **`ON DELETE SET NULL`, not CASCADE.** A post has to survive its author's
 *    erasure. Under CASCADE, deleting an account would silently delete that
 *    member's topic posts along with it, and the GDPR erasure sweep
 *    (`AccountDeletionProcessorService`) would become a content-deletion tool.
 *    SET NULL degrades the row to "authored by nobody", which still renders
 *    correctly because `author_name` and friends are stored independently and
 *    are not derived from this column.
 *
 * 3. **NO BACKFILL — intentionally.** The obvious move is to resolve
 *    `author_id` by matching `author_name` against member profiles. That was
 *    investigated and rejected as unsound:
 *
 *    - The seeded topic-post authors (`topicPostSeeds` in
 *      `src/content/content.seed.ts`) are editorial personas — 'Anika Kovač',
 *      'Céu Marques', 'Nuno Alves', 'Mariana Reis', 'Carla Nunes', 'Beatriz
 *      Lopes', 'Diogo Faria', 'Rita Vasquez' — while the seeded *members*
 *      (`src/database/seed.ts`) are Tomás Mendes, Ana Rocha, Noa Silva and Sam
 *      Costa. The two sets do not intersect at all, so a name join would match
 *      **zero** rows and the backfill would be pure ceremony.
 *    - Two of the seeds aren't personal names in the first place: 'Anonymous
 *      member' and 'Sara Pinheiro for QueerPulse Magazine' (a byline, not a
 *      member).
 *    - More importantly, `author_name` is free text and is not unique. Even
 *      where a name *did* coincide with a real member, joining on it would
 *      attribute seed content to a real person who never wrote it — which for
 *      a block/mute column is actively harmful: it would let a stranger's
 *      editorial post be hidden by (or worse, attributed to) an unrelated
 *      member.
 *
 *    Leaving these rows NULL is the correct end state for seed content, not a
 *    deferred TODO. The filter added alongside this migration is NULL-safe by
 *    construction: `excludeHidden`'s correlated `NOT EXISTS` compares
 *    `blocked_id`/`muted_id` against `author_id`, and a comparison to NULL is
 *    never true, so the subquery finds no rows and `NOT EXISTS` evaluates
 *    TRUE — NULL-authored seed posts stay visible to everyone.
 */
export class AddTopicPostAuthor1782800720000 implements MigrationInterface {
  name = 'AddTopicPostAuthor1782800720000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "topic_post" ADD "author_id" uuid`);

    await queryRunner.query(`
      ALTER TABLE "topic_post" ADD CONSTRAINT "FK_topic_post_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // Not for the block filter — that predicate is a correlated NOT EXISTS
    // against "blocks"/"mutes", which is served by those tables' own indexes.
    // This one supports the reverse lookup the erasure sweep and any future
    // "posts by member" read need: finding a member's rows by author_id.
    // Partial, because after (3) above the overwhelming majority of rows are
    // NULL and there is no reason to index them.
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_post_author_id" ON "topic_post" ("author_id") WHERE "author_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_topic_post_author_id"`);
    await queryRunner.query(
      `ALTER TABLE "topic_post" DROP CONSTRAINT "FK_topic_post_author_id"`,
    );
    await queryRunner.query(`ALTER TABLE "topic_post" DROP COLUMN "author_id"`);
  }
}
