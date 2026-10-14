import { StudioChapter, StudioTrack } from './entities/studio-track.entity';

/**
 * Studio listening rules shared by the PATCH body, the track writes, the
 * audio confirm and the response mappers
 * (QUEERPULSE-STUDIO-LISTENING-CONTRACT-2026-10-13.md A.4, A.5). Pure.
 */

export type StudioTrackMeasurements = Pick<
  StudioTrack,
  'waveformPeaks' | 'loudnessLufs' | 'peakDb'
>;

export type StudioTrackListeningReset = StudioTrackMeasurements &
  Pick<StudioTrack, 'chapters'>;

/** One decimal, the precision `numeric(4,1)` keeps. Adding zero turns the
 *  `-0` that `Math.round` gives for small negatives into `0`. */
export function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10 + 0;
}

/** Each value is at or above the one before it. */
export function isNonDecreasing(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! <= value,
  );
}

/** The first value is 0 and each later one is above the one before it. */
export function isAscendingFromZero(values: readonly number[]): boolean {
  return (
    values.length > 0 &&
    values[0] === 0 &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

/** Every chapter starts before the audio ends. A track with no duration has
 *  no confirmed audio, so no chapter fits it. */
export function areChaptersWithinDuration(
  chapters: readonly Pick<StudioChapter, 'startSeconds'>[],
  durationSeconds: number | null,
): boolean {
  if (durationSeconds === null) {
    return false;
  }
  return chapters.every((chapter) => chapter.startSeconds < durationSeconds);
}

/** The contract's `hasAnalysis`: peaks, loudness and peak level all stored.
 *  Type checks keep a partially selected row reading as unmeasured. */
export function hasTrackAnalysis(track: StudioTrackMeasurements): boolean {
  return (
    Array.isArray(track.waveformPeaks) &&
    typeof track.loudnessLufs === 'number' &&
    typeof track.peakDb === 'number'
  );
}

/**
 * What new audio does to the listening fields: the measurements describe
 * the file they were taken from, so they clear (the upload page measures the
 * new file), and chapters stay only when every one still starts inside the
 * new audio. Timed lyrics are left as they are.
 */
export function listeningFieldsForNewAudio(
  chapters: StudioChapter[] | null,
  durationSeconds: number,
): StudioTrackListeningReset {
  return {
    waveformPeaks: null,
    loudnessLufs: null,
    peakDb: null,
    chapters:
      chapters && areChaptersWithinDuration(chapters, durationSeconds)
        ? chapters
        : null,
  };
}
