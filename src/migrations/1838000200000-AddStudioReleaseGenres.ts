// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio multi-genre: a release carries up to five genres, the first one
 * leads. `studio_releases.genres` holds them in order as a `varchar(40)[]`
 * (`NOT NULL DEFAULT '{}'`, so a release with no genre holds an empty array).
 *
 * Backfill: every row with a `genre` gets `genres = ARRAY[genre]`, so a
 * release keeps the one genre it had. Rows with a null `genre` keep the
 * empty default. A stored value outside the current genre list is copied
 * as stored.
 *
 * Mirror invariant: the `genre` column stays and always equals `genres[0]`
 * (null when `genres` is empty). The release service rewrites it on every
 * write and nothing else writes either column, so no trigger or check
 * constraint backs it.
 *
 * Index swap: browse, search, the genre list and radio now match a genre
 * when the array contains it. `IDX_studio_releases_genre_published_at`
 * (a btree on `genre`) is dropped and the partial GIN index
 * `IDX_studio_releases_genres_published` on `genres`, limited to published
 * rows, takes its place. The unfiltered home feed keeps
 * `IDX_studio_releases_status_published_at`.
 *
 * `down` restores the btree index exactly as
 * `1831500100000-AddStudioReleaseFollowersNotifiedAt` built it, then drops
 * the GIN index and the column. A release that carries several genres keeps
 * its lead genre in `genre`, so `down` loses only the genres after the first.
 *
 * The studio tables are small, so both indexes build inside the migration
 * transaction.
 */
export class AddStudioReleaseGenres1838000200000 implements MigrationInterface {
  name = 'AddStudioReleaseGenres1838000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "studio_releases" ADD "genres" character varying(40) array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `UPDATE "studio_releases" SET "genres" = ARRAY["genre"] WHERE "genre" IS NOT NULL`,
    );

    await queryRunner.query(
      `DROP INDEX "IDX_studio_releases_genre_published_at"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_genres_published" ON "studio_releases" USING GIN ("genres") WHERE "status" = 'published'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_studio_releases_genres_published"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_genre_published_at" ON "studio_releases" ("genre", "published_at" DESC, "id" DESC) WHERE "status" = 'published'`,
    );

    await queryRunner.query(
      `ALTER TABLE "studio_releases" DROP COLUMN "genres"`,
    );
  }
}
