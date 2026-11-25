import { QUIZSHOW_LIMITS } from './quizshow.contract';

/**
 * Latency allowance (contract 6.3). The gateway measures round trips itself
 * with `time:probe` and keeps the last few samples per socket; an answer's
 * elapsed time is shortened by half the median round trip, capped, so a phone
 * on a slow network keeps its speed bonus. Pure functions of their arguments.
 */

/** The middle value of a sorted copy; an even count averages the two middle values. 0 for no samples. */
export function medianOf(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  // Both reads sit inside the non-empty array; the fallbacks only satisfy strict index access.
  const upperMiddle = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upperMiddle;
  const lowerMiddle = sorted[middle - 1] ?? upperMiddle;
  return (lowerMiddle + upperMiddle) / 2;
}

/** Half the median round trip, rounded, capped at `latencyAllowanceMaxMs`; 0 before any sample (contract 6.3). */
export function latencyAllowanceMs(samples: readonly number[]): number {
  return samples.length === 0
    ? 0
    : Math.min(
        Math.round(medianOf(samples) / 2),
        QUIZSHOW_LIMITS.latencyAllowanceMaxMs,
      );
}

/** Appends one round trip and keeps the newest `latencyProbeSamples`. Returns a new array. */
export function withRttSample(
  samples: readonly number[],
  sampleMs: number,
): number[] {
  return [...samples, sampleMs].slice(-QUIZSHOW_LIMITS.latencyProbeSamples);
}
