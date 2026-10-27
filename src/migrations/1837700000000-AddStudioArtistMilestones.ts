// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `studio_artist_milestones`, the moments an artist persona crossed a
 * Studio threshold: a follower count, a first playlist placement, or a play
 * count on a track or on the whole catalogue. A row is written once per
 * persona, kind, threshold and track, and stays when a count later drops, so
 * the dashboard keeps every moment the artist reached. The unique index treats
 * a missing track as one fixed uuid, which makes the persona-wide kinds unique
 * too.
 *
 * The backfill writes one `followers` row for every threshold a persona
 * already crossed, so artists see no late burst of moments the first time
 * the follower listener runs. Thresholds are 10, 25, 50, 100, 250, 500, 1000
 * and every further thousand. Each row is dated when the persona's current
 * follower number `threshold` followed, counting followers in order of
 * `created_at` with `id` breaking a tie (a `row_number()` window), so the
 * 10-follower moment carries the 10th follower's date. The window reads each
 * persona's followers once, and a persona under ten followers writes nothing.
 *
 * The persona kinds are spelled out because a migration imports no app code.
 * Keep the list identical to the keys of `STUDIO_FORMAT_BY_KIND`.
 */
export class AddStudioArtistMilestones1837700000000 implements MigrationInterface {
  name = 'AddStudioArtistMilestones1837700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_artist_milestones_kind_enum" AS ENUM ('followers', 'first_placement', 'track_plays', 'artist_plays')`,
    );
    await queryRunner.query(
      `CREATE TABLE "studio_artist_milestones" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subprofile_id" uuid NOT NULL,
        "kind" "studio_artist_milestones_kind_enum" NOT NULL,
        "threshold" integer NOT NULL,
        "track_id" uuid,
        "reached_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_artist_milestones" PRIMARY KEY ("id"),
        CONSTRAINT "FK_studio_artist_milestones_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_artist_milestones_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_artist_milestones_subject" ON "studio_artist_milestones"
        ("subprofile_id", "kind", "threshold", COALESCE("track_id", '00000000-0000-0000-0000-000000000000'::uuid))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_artist_milestones_subprofile_reached_at" ON "studio_artist_milestones"
        ("subprofile_id", "reached_at" DESC)`,
    );
    await queryRunner.query(
      `INSERT INTO "studio_artist_milestones" ("subprofile_id", "kind", "threshold", "reached_at")
       SELECT "ranked"."subprofile_id", 'followers', "ranked"."follower_rank"::int, "ranked"."created_at"
         FROM (
           SELECT "follower"."subprofile_id",
                  "follower"."created_at",
                  row_number() OVER (
                    PARTITION BY "follower"."subprofile_id"
                    ORDER BY "follower"."created_at" ASC, "follower"."id" ASC
                  ) AS "follower_rank"
             FROM "subprofile_followers" "follower"
            INNER JOIN "subprofiles" "persona" ON "persona"."id" = "follower"."subprofile_id"
            WHERE "persona"."kind"::text IN ('musician', 'dj', 'podcaster', 'podcast_producer', 'poet', 'spoken_word', 'drag', 'performer', 'dancer', 'voguer', 'burlesque')
         ) "ranked"
        WHERE "ranked"."follower_rank" IN (10, 25, 50, 100, 250, 500, 1000)
           OR ("ranked"."follower_rank" >= 2000 AND "ranked"."follower_rank" % 1000 = 0)
       ON CONFLICT DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "studio_artist_milestones"`);
    await queryRunner.query(`DROP TYPE "studio_artist_milestones_kind_enum"`);
  }
}
