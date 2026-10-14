import { numericColumnToNumber } from './entities/studio-track.entity';
import {
  areChaptersWithinDuration,
  hasTrackAnalysis,
  isAscendingFromZero,
  isNonDecreasing,
  listeningFieldsForNewAudio,
  roundToTenth,
} from './studio-track-listening';

const PEAKS = Array.from({ length: 200 }, (_unused, index) => index);

describe('Studio listening rules', () => {
  it('rounds a measurement to one decimal and turns minus zero into zero', () => {
    expect(roundToTenth(-7.84)).toBe(-7.8);
    expect(roundToTenth(-0.06)).toBe(-0.1);
    expect(roundToTenth(-14)).toBe(-14);
    expect(roundToTenth(-0.04)).toBe(0);
    expect(Object.is(roundToTenth(-0.04), 0)).toBe(true);
  });

  it('reads equal neighbours as non-decreasing and a drop as out of order', () => {
    expect(isNonDecreasing([])).toBe(true);
    expect(isNonDecreasing([0, 0, 4000])).toBe(true);
    expect(isNonDecreasing([5000, 4000])).toBe(false);
  });

  it('wants a timeline that starts at zero and only climbs', () => {
    expect(isAscendingFromZero([0, 95, 200])).toBe(true);
    expect(isAscendingFromZero([0])).toBe(true);
    expect(isAscendingFromZero([])).toBe(false);
    expect(isAscendingFromZero([5, 95])).toBe(false);
    expect(isAscendingFromZero([0, 0])).toBe(false);
    expect(isAscendingFromZero([0, 300, 200])).toBe(false);
  });

  it('keeps every chapter start below the duration', () => {
    const chapters = [{ startSeconds: 0 }, { startSeconds: 199 }];
    expect(areChaptersWithinDuration(chapters, 200)).toBe(true);
    expect(areChaptersWithinDuration(chapters, 199)).toBe(false);
    expect(areChaptersWithinDuration([{ startSeconds: 0 }], null)).toBe(false);
  });

  it('counts a track as measured only with peaks, loudness and peak level', () => {
    expect(
      hasTrackAnalysis({
        waveformPeaks: PEAKS,
        loudnessLufs: -9.5,
        peakDb: -0.4,
      }),
    ).toBe(true);
    expect(
      hasTrackAnalysis({
        waveformPeaks: null,
        loudnessLufs: -9.5,
        peakDb: -0.4,
      }),
    ).toBe(false);
    expect(
      hasTrackAnalysis({
        waveformPeaks: PEAKS,
        loudnessLufs: null,
        peakDb: null,
      }),
    ).toBe(false);
  });

  it('clears the measurements for new audio and keeps chapters that still fit', () => {
    const chapters = [
      { startSeconds: 0, title: 'Intro', artist: null },
      { startSeconds: 241, title: 'Outro', artist: 'Ana Moura' },
    ];
    expect(listeningFieldsForNewAudio(chapters, 242)).toEqual({
      waveformPeaks: null,
      loudnessLufs: null,
      peakDb: null,
      chapters,
    });
    expect(listeningFieldsForNewAudio(chapters, 241).chapters).toBeNull();
    expect(listeningFieldsForNewAudio(null, 242).chapters).toBeNull();
  });

  it('reads numeric columns as numbers', () => {
    expect(numericColumnToNumber.from('-7.8')).toBe(-7.8);
    expect(numericColumnToNumber.from('0.0')).toBe(0);
    expect(numericColumnToNumber.from(null)).toBeNull();
    expect(numericColumnToNumber.to(-7.8)).toBe(-7.8);
    expect(numericColumnToNumber.to(null)).toBeNull();
  });
});
