import { runWithConcurrency } from './run-with-concurrency';

// A thunk that resolves after `resolveAfterMs` of real time, recording how many
// of its peers were running alongside it. Real timers on purpose: these are
// order and count assertions, not timing ones, and the pool awaits the thunks,
// so fake timers would need advancing from inside the await chain and would
// simply deadlock the suite.
//
// `peakConcurrency` is what the cap is actually asserted against: counting
// starts when the thunk is invoked and ends when it settles, so a helper that
// started everything in one tick would show a peak equal to the task count.
function makeTracker() {
  let currentConcurrency = 0;
  let peakConcurrency = 0;
  function task<TaskValue>(
    value: TaskValue,
    resolveAfterMs: number,
  ): () => Promise<TaskValue> {
    return async () => {
      currentConcurrency += 1;
      peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
      await new Promise((resolve) => setTimeout(resolve, resolveAfterMs));
      currentConcurrency -= 1;
      return value;
    };
  }
  return {
    task,
    get peakConcurrency() {
      return peakConcurrency;
    },
  };
}

describe('runWithConcurrency', () => {
  it('returns results in input order even when tasks settle out of order', async () => {
    const tracker = makeTracker();

    const results = await runWithConcurrency(
      [
        tracker.task('first', 30),
        tracker.task('second', 5),
        tracker.task('third', 20),
        tracker.task('fourth', 1),
      ],
      2,
    );

    // `toStrictEqual`, not `toEqual`: an array hole reads back as `undefined`
    // and `toEqual` treats a hole as equal to it, so only the strict form can
    // catch a slot the pool failed to write.
    expect(results).toStrictEqual(['first', 'second', 'third', 'fourth']);
  });

  it('never runs more than the cap at once', async () => {
    const tracker = makeTracker();
    const thunks = Array.from({ length: 20 }, (_unused, index) =>
      tracker.task(index, 5),
    );

    await runWithConcurrency(thunks, 3);

    // Exactly 3, not at most 3: the workers are invoked synchronously by
    // `Array.from`, and each thunk raises the count before its first await, so
    // the peak is reached in the tick the pool is entered. If the pool ever
    // starts workers asynchronously this becomes racy and should be relaxed.
    expect(tracker.peakConcurrency).toBe(3);
  });

  it('starts queued work while a slow task is still running', async () => {
    // The regression this guards, and the reason it is written the awkward way.
    // A wave-based helper holds every task behind the slowest member of its
    // wave, so with a cap of 2 tasks 2 and 3 could not start until the 50ms
    // task finished. Asserting the FINAL start order would not catch that:
    // waves also start tasks in ascending order, so that assertion passes
    // either way. The evidence has to be captured from inside the slow task,
    // while it is still holding its worker.
    const startOrder: number[] = [];
    let startedBeforeSlowTaskFinished: number[] = [];
    const slowTask = async (): Promise<void> => {
      startOrder.push(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      startedBeforeSlowTaskFinished = [...startOrder];
    };
    const fastTask = (label: number) => async (): Promise<void> => {
      startOrder.push(label);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };

    await runWithConcurrency(
      [slowTask, fastTask(1), fastTask(2), fastTask(3)],
      2,
    );

    // Under waves this would be [0, 1]: tasks 2 and 3 would still be queued
    // behind the barrier when the slow task took its snapshot.
    expect(startedBeforeSlowTaskFinished).toStrictEqual([0, 1, 2, 3]);
  });

  it('runs everything sequentially when the cap is one', async () => {
    const tracker = makeTracker();
    const thunks = Array.from({ length: 5 }, (_unused, index) =>
      tracker.task(index, 1),
    );

    const results = await runWithConcurrency(thunks, 1);

    expect(results).toStrictEqual([0, 1, 2, 3, 4]);
    expect(tracker.peakConcurrency).toBe(1);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['not a number', Number.NaN],
  ])(
    'treats a cap that is %s as one instead of dropping the work',
    async (_label, cap) => {
      // A bad cap reaching this helper (an env knob read as
      // `DATABASE_POOL_MAX=0`, or unset entirely, which parses to NaN) must not
      // silently resolve without running the tasks. NaN is the dangerous one:
      // `Math.max(1, NaN)` is NaN, and `Array.from({ length: NaN })` is empty,
      // so an unguarded clamp spawns zero workers and reports success.
      const tracker = makeTracker();
      const thunks = Array.from({ length: 3 }, (_unusedEntry, index) =>
        tracker.task(index, 1),
      );

      await expect(runWithConcurrency(thunks, cap)).resolves.toStrictEqual([
        0, 1, 2,
      ]);
      expect(tracker.peakConcurrency).toBe(1);
    },
  );

  it('resolves to an empty array for no tasks', async () => {
    await expect(runWithConcurrency([], 4)).resolves.toStrictEqual([]);
  });

  it('waits for every worker to stop before rejecting', async () => {
    // `Promise.all` would reject at the first fault while the other workers
    // were still claiming tasks and opening sockets, so the caller would resume
    // with work still running behind it. Settling means stopped.
    let isSlowTaskStillRunning = false;
    const results = await runWithConcurrency(
      [
        async () => {
          throw new Error('first task failed');
        },
        async () => {
          isSlowTaskStillRunning = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
          isSlowTaskStillRunning = false;
        },
      ],
      2,
    ).catch((error: unknown) => error);

    expect(results).toBeInstanceOf(Error);
    expect((results as Error).message).toBe('first task failed');
    expect(isSlowTaskStillRunning).toBe(false);
  });
});
