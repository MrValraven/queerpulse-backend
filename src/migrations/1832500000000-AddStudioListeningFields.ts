// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio listening (QUEERPULSE-STUDIO-LISTENING-CONTRACT-2026-10-13.md A.5):
 * five nullable columns on `studio_tracks`, written by the owner's PATCH
 * from numbers the uploader's browser measured. The server stores and
 * validates numbers and reads no audio.
 *
 * - `waveform_peaks`: 200 integers from 0 to 255.
 * - `loudness_lufs` and `peak_db`: one decimal each, set and cleared together.
 * - `synced_lyrics`: a JSON list of `{ ms, text }`, 1 to 500 lines.
 * - `chapters`: a JSON list of `{ startSeconds, title, artist }`, 1 to 100.
 *
 * The checks hold the shapes the API validates, so a row written outside the
 * API still reads as the wire contract promises. Ordering inside the JSON
 * lists, and chapter starts against the duration, stay with the API. Existing
 * tracks read as unmeasured (all five null); the release editor measures
 * saved tracks in the owner's browser, so nothing is backfilled here.
 *
 * `studio_tracks` is a Studio v1 table that has not launched, so the checks
 * validate inside the migration transaction.
 */
export class AddStudioListeningFields1832500000000 implements MigrationInterface {
  name = 'AddStudioListeningFields1832500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "studio_tracks"
         ADD "waveform_peaks" smallint[],
         ADD "loudness_lufs" numeric(4,1),
         ADD "peak_db" numeric(4,1),
         ADD "synced_lyrics" jsonb,
         ADD "chapters" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks" ADD CONSTRAINT "CHK_studio_tracks_waveform_peaks" CHECK ("waveform_peaks" IS NULL OR (array_ndims("waveform_peaks") = 1 AND cardinality("waveform_peaks") = 200 AND array_position("waveform_peaks", NULL) IS NULL AND 0 <= ALL ("waveform_peaks") AND 255 >= ALL ("waveform_peaks")))`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks" ADD CONSTRAINT "CHK_studio_tracks_loudness_lufs" CHECK ("loudness_lufs" IS NULL OR "loudness_lufs" BETWEEN -70 AND 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks" ADD CONSTRAINT "CHK_studio_tracks_peak_db" CHECK ("peak_db" IS NULL OR "peak_db" BETWEEN -60 AND 3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks" ADD CONSTRAINT "CHK_studio_tracks_loudness_pair" CHECK (("loudness_lufs" IS NULL) = ("peak_db" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks" ADD CONSTRAINT "CHK_studio_tracks_synced_lyrics" CHECK ("synced_lyrics" IS NULL OR (CASE WHEN jsonb_typeof("synced_lyrics") = 'array' THEN jsonb_array_length("synced_lyrics") BETWEEN 1 AND 500 ELSE false END))`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks" ADD CONSTRAINT "CHK_studio_tracks_chapters" CHECK ("chapters" IS NULL OR (CASE WHEN jsonb_typeof("chapters") = 'array' THEN jsonb_array_length("chapters") BETWEEN 1 AND 100 ELSE false END))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "studio_tracks"
         DROP CONSTRAINT "CHK_studio_tracks_chapters",
         DROP CONSTRAINT "CHK_studio_tracks_synced_lyrics",
         DROP CONSTRAINT "CHK_studio_tracks_loudness_pair",
         DROP CONSTRAINT "CHK_studio_tracks_peak_db",
         DROP CONSTRAINT "CHK_studio_tracks_loudness_lufs",
         DROP CONSTRAINT "CHK_studio_tracks_waveform_peaks"`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_tracks"
         DROP COLUMN "chapters",
         DROP COLUMN "synced_lyrics",
         DROP COLUMN "peak_db",
         DROP COLUMN "loudness_lufs",
         DROP COLUMN "waveform_peaks"`,
    );
  }
}
