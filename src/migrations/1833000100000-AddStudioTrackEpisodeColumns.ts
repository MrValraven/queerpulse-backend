// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio artist kinds (`QUEERPULSE-STUDIO-ARTIST-KINDS-DESIGN-2026-10-14.md`):
 * four columns on `studio_tracks`.
 *
 * - `notes`: show notes of a podcast episode, up to 4000 characters.
 * - `sources`: the songs an edit, a lip-sync mix or a mix credits, a JSON
 *   list of `{ title, artist }`, at most 100 rows.
 * - `published_at`: when a podcast episode came out (millisecond precision,
 *   the latest-episodes keyset cursor). Null on draft episodes and on every
 *   other release type's tracks.
 * - `followers_notified_at`: the once-only claim of the episode alert.
 *
 * Two partial indexes over published episodes: one per show, newest first,
 * and one across shows for the latest-episodes feed. No backfill: no
 * podcast release exists before this migration, and existing tracks read
 * as having no notes and no sources. `studio_tracks` belongs to the
 * unlaunched Studio, so every index builds inside the migration
 * transaction. Runs after `AddStudioArtistKindEnumValues1833000000000`.
 */
export class AddStudioTrackEpisodeColumns1833000100000 implements MigrationInterface {
  name = 'AddStudioTrackEpisodeColumns1833000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "studio_tracks"
         ADD "notes" text,
         ADD "sources" jsonb NOT NULL DEFAULT '[]',
         ADD "published_at" TIMESTAMP(3) WITH TIME ZONE,
         ADD "followers_notified_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks" ADD CONSTRAINT "CHK_studio_tracks_sources" CHECK (CASE WHEN jsonb_typeof("sources") = 'array' THEN jsonb_array_length("sources") <= 100 ELSE false END)`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks" ADD CONSTRAINT "CHK_studio_tracks_notes" CHECK ("notes" IS NULL OR char_length("notes") <= 4000)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_tracks_release_published_at" ON "studio_tracks" ("release_id", "published_at" DESC) WHERE "published_at" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_tracks_published_at" ON "studio_tracks" ("published_at" DESC, "id" DESC) WHERE "published_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_studio_tracks_published_at"`);
    await queryRunner.query(
      `DROP INDEX "IDX_studio_tracks_release_published_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks"
         DROP CONSTRAINT "CHK_studio_tracks_notes",
         DROP CONSTRAINT "CHK_studio_tracks_sources",
         DROP COLUMN "followers_notified_at",
         DROP COLUMN "published_at",
         DROP COLUMN "sources",
         DROP COLUMN "notes"`,
    );
  }
}
