/**
 * Runs `taskThunks` with at most `maxConcurrentTasks` in flight at any moment,
 * returning their results in INPUT order. A fixed set of workers pulls from a
 * shared cursor, so a task starts the instant any worker frees up.
 *
 * The bound is the point: `DATABASE_POOL_MAX` defaults to 10 connections on a
 * single-replica backend, and `DATABASE_CONNECTION_TIMEOUT_MS` gives a request
 * 10 seconds to get a slot before it fails outright, so an uncapped fan-out
 * (hundreds of queries, writes, or outbound sockets opened in one tick) starves
 * every unrelated request sharing that pool and can fail them outright once the
 * wait exceeds that timeout.
 *
 * A sliding pool rather than sequential waves of `Promise.all`, deliberately.
 * Waves impose a barrier: every wave costs its SLOWEST member, so one hung
 * endpoint among eight makes the whole wave wait out that timeout while the
 * other seven sit idle, and total time becomes `waveCount x slowest` instead of
 * `totalWork / concurrency`. On a fan-out of hundreds against a provider that
 * can hang, that is the difference between seconds and minutes.
 *
 * Entries MUST be thunks rather than started promises. An already-started
 * promise has claimed its connection or its socket before this function ever
 * sees it, so passing one silently defeats the cap.
 *
 * On a rejecting thunk this settles only once every worker has stopped, then
 * rethrows the first rejection. That is deliberately NOT `Promise.all`, which
 * would reject while the other workers were still claiming tasks, opening
 * sockets and holding pool connections after the caller had already moved on
 * and past any shutdown hook that thought the fan-out was over. Here the
 * returned promise settling means the work has actually stopped. A caller that
 * must attempt every item (the push fan-out in `PushService.sendToUsers`)
 * should still catch inside the thunk, since a rejection costs that worker.
 *
 * `SearchService` carries an older private wave-based copy of this idea
 * (`search.service.ts`, capping its 12 per-type queries at 5). Its fan-out is
 * 12 tasks of similar cost, so the barrier costs it little, but it should fold
 * into this shared version the next time that file is open for another reason.
 */
export async function runWithConcurrency<TaskResult>(
  taskThunks: Array<() => Promise<TaskResult>>,
  maxConcurrentTasks: number,
): Promise<TaskResult[]> {
  const results = new Array<TaskResult>(taskThunks.length);
  // `Number.isFinite` first, because `Math.max(1, NaN)` is NaN, not 1, and
  // `Array.from({ length: NaN })` is empty: a NaN cap would spawn no workers,
  // run nothing, and resolve as though it had succeeded. NaN is exactly what an
  // unset env knob gives you, and this file invites callers to size the cap
  // from `DATABASE_POOL_MAX`.
  const boundedConcurrency = Number.isFinite(maxConcurrentTasks)
    ? Math.max(1, Math.floor(maxConcurrentTasks))
    : 1;
  const workerCount = Math.min(boundedConcurrency, taskThunks.length);
  let nextTaskIndex = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextTaskIndex < taskThunks.length) {
      // Claim the index before awaiting so two workers can never take the same
      // task: the read, the increment and the lookup are one synchronous block
      // with no suspension point between them.
      const taskIndex = nextTaskIndex;
      nextTaskIndex += 1;
      const taskThunk = taskThunks[taskIndex];
      if (!taskThunk) {
        // Unreachable for a dense array, and only typed as possible because
        // `noUncheckedIndexedAccess` is on. Throwing rather than skipping: a
        // skip would leave a hole that reads back as `undefined` while every
        // other slot stayed correctly aligned, which is the kind of wrong the
        // caller cannot see.
        throw new TypeError(
          `runWithConcurrency received no thunk at index ${taskIndex}`,
        );
      }
      results[taskIndex] = await taskThunk();
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const firstRejection = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected',
  );
  if (firstRejection) throw firstRejection.reason;
  return results;
}
