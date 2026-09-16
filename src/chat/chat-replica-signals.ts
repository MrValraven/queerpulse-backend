/**
 * Single source of truth for "how many replicas of this process are running"
 * and "has the operator explicitly accepted the single-replica constraint",
 * shared between `env.validation.ts` (fails config load fast, before any
 * provider exists) and `ChatSingleInstanceGuard` (fails Nest bootstrap, after
 * config has already passed). Before this file existed the two read different
 * variables and honoured different override names, so the same environment
 * could pass one gate and crash, or silently pass both, depending on which
 * variable an operator happened to set.
 *
 * ONLY two variables carry an actual replica COUNT: `REPLICA_COUNT` (the
 * explicit knob) and `WEB_CONCURRENCY` (the de-facto standard most process
 * managers honour, where each worker is its own OS process with its own
 * in-memory stores, so it multiplies the same way a replica does).
 *
 * Railway does NOT document a "how many replicas" environment variable at
 * all. It sets `RAILWAY_REPLICA_ID` on each running instance (which replica
 * this one is), and that value says nothing about how many siblings exist:
 * a lone replica and the third of five both just see a value in that
 * variable. Treating its mere presence as a count, or inventing a
 * plausible-looking name Railway never actually sets (earlier code guessed at
 * `RAILWAY_SERVICE_NUM_REPLICAS` / `RAILWAY_REPLICA_COUNT`), gives false
 * confidence: the check compiles and reads clean, but never fires on the one
 * platform this app deploys to. `isRunningOnRailwayWithUndeclaredReplicaCount`
 * below exists only to log that limitation loudly, never to gate a boot
 * decision on it.
 */

/** The one variable that acknowledges running past one replica, for both gates. */
export const REPLICA_OVERRIDE_ENV_VARIABLE = 'ALLOW_MULTI_REPLICA';

export interface DeclaredReplicaCounts {
  REPLICA_COUNT?: number;
  WEB_CONCURRENCY?: number;
}

/**
 * The larger of the declared counts, or `null` when neither is set. Callers
 * that want a numeric default (most want `?? 1`) apply it themselves, so this
 * stays a pure "what did the environment actually say" function.
 */
export function declaredReplicaCount(
  counts: DeclaredReplicaCounts,
): number | null {
  const declaredCounts = [counts.REPLICA_COUNT, counts.WEB_CONCURRENCY].filter(
    (declaredCount): declaredCount is number =>
      typeof declaredCount === 'number' &&
      Number.isFinite(declaredCount) &&
      declaredCount > 0,
  );
  if (declaredCounts.length === 0) {
    return null;
  }
  return Math.max(...declaredCounts);
}

/**
 * Same computation as {@link declaredReplicaCount}, parsed straight off
 * `process.env`. For `ChatSingleInstanceGuard`, which deliberately reads
 * platform-injected deployment facts directly rather than through
 * `ConfigService` (see that guard's class doc). `env.validation.ts` instead
 * calls {@link declaredReplicaCount} with the numbers `class-validator` already
 * parsed, so both gates run the same arithmetic over the same two variables.
 */
export function declaredReplicaCountFromProcessEnv(): number | null {
  const parsePositiveInteger = (
    rawValue: string | undefined,
  ): number | undefined => {
    if (rawValue === undefined || rawValue.trim() === '') {
      return undefined;
    }
    const parsedValue = Number.parseInt(rawValue.trim(), 10);
    return Number.isFinite(parsedValue) && parsedValue > 0
      ? parsedValue
      : undefined;
  };
  return declaredReplicaCount({
    REPLICA_COUNT: parsePositiveInteger(process.env.REPLICA_COUNT),
    WEB_CONCURRENCY: parsePositiveInteger(process.env.WEB_CONCURRENCY),
  });
}

/**
 * Has the operator acknowledged the single-replica constraint? Only the exact
 * string `'true'` counts, matching the documented behaviour of
 * `ALLOW_MULTI_REPLICA` in `.env.example` and `env.validation.ts`. Accepting
 * `'1'`/`'yes'` as well would let the two gates disagree again the moment one
 * of them normalised loosely and the other did not.
 */
export function isMultiReplicaAcknowledged(
  rawValue: string | undefined,
): boolean {
  return rawValue === 'true';
}

/**
 * True when this process is running on Railway (`RAILWAY_REPLICA_ID` is set)
 * with no declared replica count from either `REPLICA_COUNT` or
 * `WEB_CONCURRENCY`. Railway exposes no variable this app can read to learn
 * the actual replica count, so this can only ever mean "unknown", never
 * "safe" or "unsafe". It exists to name that gap in the boot log rather than
 * to gate anything.
 */
export function isRunningOnRailwayWithUndeclaredReplicaCount(): boolean {
  const hasRailwayReplicaId =
    process.env.RAILWAY_REPLICA_ID !== undefined &&
    process.env.RAILWAY_REPLICA_ID.trim() !== '';
  return hasRailwayReplicaId && declaredReplicaCountFromProcessEnv() === null;
}
