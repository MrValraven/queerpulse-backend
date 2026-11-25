import { QUIZSHOW_LIMITS } from './quizshow.contract';
import {
  latencyAllowanceMs,
  medianOf,
  withRttSample,
} from './quizshow-latency';

describe('medianOf', () => {
  it('reads the middle value of an odd count from a sorted copy', () => {
    const samples = [10, 30, 20];
    expect(medianOf(samples)).toBe(20);
    expect(samples).toEqual([10, 30, 20]);
  });

  it('averages the two middle values of an even count', () => {
    expect(medianOf([10, 20, 30, 40])).toBe(25);
  });
});

describe('latencyAllowanceMs', () => {
  it('is 0 before any sample', () => {
    expect(latencyAllowanceMs([])).toBe(0);
  });

  it('is half the median round trip', () => {
    expect(latencyAllowanceMs([100, 120, 140])).toBe(60);
  });

  it('caps at latencyAllowanceMaxMs', () => {
    expect(latencyAllowanceMs([2000])).toBe(400);
    expect(QUIZSHOW_LIMITS.latencyAllowanceMaxMs).toBe(400);
  });
});

describe('withRttSample', () => {
  it('keeps the newest latencyProbeSamples round trips', () => {
    let samples: number[] = [];
    for (let sampleMs = 1; sampleMs <= 7; sampleMs += 1) {
      samples = withRttSample(samples, sampleMs);
    }
    expect(QUIZSHOW_LIMITS.latencyProbeSamples).toBe(5);
    expect(samples).toEqual([3, 4, 5, 6, 7]);
  });

  it('leaves the given array unchanged', () => {
    const samples = [10, 20];
    expect(withRttSample(samples, 30)).toEqual([10, 20, 30]);
    expect(samples).toEqual([10, 20]);
  });
});
