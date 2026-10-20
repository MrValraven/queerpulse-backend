// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio listening: clears every stored track waveform so it is measured
 * again. The old peaks were the loudest sample in each slice, which drew a
 * loud mastered song as a solid block; the upload page now stores the energy
 * in each slice. A track with NULL `waveform_peaks` reads as unanalysed
 * (`hasTrackAnalysis` in `src/studio/studio-track-listening.ts`), and the
 * release editor backfill redraws it the next time its owner opens the
 * release.
 *
 * A taken-down release keeps its old peaks: track edits refuse it, so the
 * backfill could never write new ones, and a restored release still draws.
 *
 * `loudness_lufs` and `peak_db` stay as they are: they were measured right
 * and the `CHK_studio_tracks_waveform_peaks` check accepts NULL peaks beside
 * them. Purely data, no DDL.
 */
export class ClearStudioWaveformPeaks1836800000000 implements MigrationInterface {
  name = 'ClearStudioWaveformPeaks1836800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "studio_tracks" AS "track" SET "waveform_peaks" = NULL
       FROM "studio_releases" AS "release"
       WHERE "release"."id" = "track"."release_id"
         AND "release"."status" <> 'taken_down'
         AND "track"."waveform_peaks" IS NOT NULL`,
    );
  }

  public async down(): Promise<void> {
    // The old peaks cannot be restored, and the editor backfill refills them.
  }
}
