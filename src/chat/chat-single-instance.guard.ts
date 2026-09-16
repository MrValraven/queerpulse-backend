import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import {
  REPLICA_OVERRIDE_ENV_VARIABLE,
  declaredReplicaCountFromProcessEnv,
  isMultiReplicaAcknowledged,
  isRunningOnRailwayWithUndeclaredReplicaCount,
} from './chat-replica-signals';
import { ChatGatewayInstanceHeartbeat } from './entities/chat-gateway-instance-heartbeat.entity';

/**
 * How often this instance upserts its own heartbeat row and sweeps the table
 * for evidence of a sibling (ENG-258). Cheap by design: one upsert-by-primary-
 * key plus one bounded `SELECT` of a table that never holds more than a
 * handful of rows, on a cadence loose enough that it never competes with the
 * gateway's actual write traffic for connection-pool headroom.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * How old a heartbeat row may be before this instance stops counting it as
 * evidence of a LIVE process at all. Four missed ticks' worth of slack
 * (`HEARTBEAT_INTERVAL_MS` * ~4.5) absorbs a slow GC pause or a brief DB blip
 * on either side without losing track of a genuine sibling mid-detection,
 * while still being short enough that a crashed instance's last row ages out
 * on a human-irrelevant timescale.
 */
export const HEARTBEAT_STALENESS_THRESHOLD_MS = 90_000;

/**
 * Every piece of live-chat state in this module is PROCESS-LOCAL:
 *
 *  - `PresenceService` is an in-memory `Map` of user -> socket ids.
 *  - `TokenBucketLimiter` (WS send/typing/delivered limits) is an in-memory Map.
 *  - `ChatGateway.handleSessionRevoked` / `handleLockdownEnabled` can only
 *    disconnect sockets attached to THIS process.
 *  - Every broadcast (`message:new`, `typing`, `read`, reactions, pins) is a
 *    socket.io room emit, and socket.io rooms are per-process without an
 *    adapter.
 *
 * That is a correct design for one replica and a silently broken one for two.
 * With a second replica: a member whose session was revoked (logout, suspension,
 * ban) keeps live sockets on every replica that did not handle the request;
 * presence reports members offline to half the fleet; per-user WS rate limits
 * become N times looser; and a message POSTed to replica A never reaches the
 * sockets sitting on replica B, so chat just stops arriving live with no error
 * anywhere.
 *
 * None of that surfaces as a crash, so the single-replica assumption was only
 * ever a comment. This makes it an assertion the process checks out loud at
 * boot, and refuses when the environment says otherwise.
 *
 * TWO INDEPENDENT DETECTION PATHS, because they catch different failures:
 *
 *  1. **Declared-count (unchanged, synchronous, at boot only).**
 *     `REPLICA_COUNT`/`WEB_CONCURRENCY` say a scale-out is coming BEFORE any
 *     second process exists, so this can refuse to even finish booting.
 *  2. **Runtime heartbeat (ENG-258, below).** Railway exposes no variable
 *     that names an actual replica COUNT (see `chat-replica-signals.ts`'s
 *     doc), `RAILWAY_REPLICA_ID` only names WHICH replica a given process
 *     is, so a scale-out done from the Railway dashboard is invisible to
 *     path 1 entirely. This instance instead upserts its own identity into
 *     `chat_gateway_instance_heartbeats` on a short interval and watches for
 *     a SECOND identity's timestamp genuinely ADVANCING between two of its
 *     own observations. Recency by wall clock alone is insufficient: a row
 *     left behind by the PREVIOUS boot of this very instance would also
 *     satisfy that test for a while after it stops being renewed. See
 *     {@link reconcilePeerObservations}'s doc for exactly why two
 *     observations are required before this ever trips.
 *
 * WHAT A REAL SCALE-OUT NEEDS (none of it is in place, and none of it can be
 * added here without new dependencies):
 *
 *  1. `@socket.io/redis-adapter` + a Redis client, wired through a custom
 *     `IoAdapter` passed to `app.useWebSocketAdapter()` in `main.ts`, so room
 *     emits and `socketsLeave`/`disconnectSockets` fan out across replicas.
 *  2. `PresenceService` backed by Redis (a per-user socket-id set with a TTL
 *     and a heartbeat, so a replica dying does not strand a member "online"
 *     forever).
 *  3. `TokenBucketLimiter` backed by Redis, and `ThrottlerModule` given a
 *     shared storage, so HTTP and WS budgets are per-member rather than
 *     per-member-per-replica.
 *  4. Session revocation and lockdown broadcast over a shared channel (the same
 *     Redis pub/sub) rather than the in-process `EventEmitter2`.
 *  5. The `@nestjs/schedule` crons (reminders, retention, the digest drain)
 *     given a leader election or an advisory lock, so they run once per tick
 *     across the fleet rather than once per replica.
 */
@Injectable()
export class ChatSingleInstanceGuard
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ChatSingleInstanceGuard.name);
  /** `RAILWAY_REPLICA_ID` where present, otherwise a fresh id minted once
   *  per process boot, never reused, including across two overlapping
   *  processes on the same host. */
  private readonly instanceId = resolveInstanceId();
  /** The last `last_seen_at` (epoch ms) this instance has OBSERVED for each
   *  OTHER instance id still inside the freshness window. A row's mere
   *  presence here never trips anything by itself, see
   *  {@link reconcilePeerObservations}. */
  private readonly lastObservedPeerHeartbeatMs = new Map<string, number>();
  /** Other instance ids whose heartbeat has been seen to genuinely ADVANCE
   *  between two of this instance's own observations, the one signal this
   *  guard treats as proof of a currently-live sibling. */
  private readonly confirmedLiveSiblingIds = new Set<string>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(ChatGatewayInstanceHeartbeat)
    private readonly heartbeats: Repository<ChatGatewayInstanceHeartbeat>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Read straight off `process.env` rather than through `ConfigService`:
    // these are platform-injected deployment facts (Railway, Heroku, pm2), not
    // application settings, so none of them belongs in a config namespace or in
    // `env.validation.ts`. The count and the override are computed by
    // `chat-replica-signals.ts`, the same helper `env.validation.ts` calls, so
    // the two boot-time gates can never disagree about the same environment.
    const acknowledged = isMultiReplicaAcknowledged(
      process.env[REPLICA_OVERRIDE_ENV_VARIABLE],
    );
    const declaredReplicas = declaredReplicaCountFromProcessEnv();

    if (declaredReplicas !== null && declaredReplicas > 1 && !acknowledged) {
      throw new Error(
        `Refusing to start: the chat gateway holds presence, WS rate limits and ` +
          `socket.io rooms in process memory, so it is safe on exactly ONE ` +
          `replica, but this environment declares ${declaredReplicas}. Live ` +
          `messages, revoked sessions and lockdown disconnects would each reach ` +
          `only the replica that handled the request. Scale back to one replica, ` +
          `or wire a socket.io Redis adapter and shared presence/limit stores ` +
          `first (see ChatSingleInstanceGuard's doc for the full list). ` +
          `${REPLICA_OVERRIDE_ENV_VARIABLE}=true overrides this, knowingly.`,
      );
    }

    // ENG-258: starts BEFORE the `acknowledged` early-return below, so the
    // heartbeat keeps writing (and this instance keeps being visible to any
    // sibling's own sweep) even when THIS process is the one carrying the
    // override. Whether a confirmed sibling actually TRIPS anything is
    // decided inside `tripMultiReplicaDetected`, which honours the override
    // itself, see that method's own comment for why the write stays
    // unconditional while only the trip is gated.
    await this.heartbeatAndSweep();
    const timer = setInterval(() => {
      void this.heartbeatAndSweep();
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    this.heartbeatTimer = timer;

    if (acknowledged) {
      this.logger.warn(
        `${REPLICA_OVERRIDE_ENV_VARIABLE} is set: the single-replica assertion ` +
          'is disabled. Presence, WS rate limits, session revocation and every ' +
          'socket.io room emit remain process-local, so live chat is only ' +
          'correct if a shared adapter is in front of them.',
      );
      return;
    }

    if (isRunningOnRailwayWithUndeclaredReplicaCount()) {
      this.logger.warn(
        'Running on Railway (RAILWAY_REPLICA_ID is set) with no declared ' +
          'replica count: Railway exposes no variable this app can read to ' +
          'learn how many replicas are actually running from config alone. ' +
          'The runtime heartbeat sweep above (ENG-258) is what actually ' +
          'catches a scale-out done from the Railway dashboard; this warning ' +
          'names the gap the config-only check still cannot see on its own.',
      );
    }

    this.logger.log(
      'Chat gateway running in single-instance mode: presence, WS rate limits ' +
        'and socket.io rooms are process-local. Do not scale this service past ' +
        'one replica without a socket.io Redis adapter.',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    // Best-effort tidy-up on a clean stop, so a graceful redeploy does not
    // even leave a row behind for the staleness window to have to age out.
    // Never allowed to fail the shutdown sequence over it: a crash (the
    // common case this whole mechanism exists for) skips this anyway, which
    // is exactly why `reconcilePeerObservations` cannot rely on rows being
    // cleaned up and must age them out by `lastSeenAt` instead.
    try {
      await this.heartbeats.delete({ instanceId: this.instanceId });
    } catch (error) {
      this.logger.warn(
        `Failed to remove this instance's heartbeat row on shutdown (harmless, ` +
          `it will age out): ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  /**
   * One tick: upsert this instance's own heartbeat, read back every row still
   * inside the freshness window, and reconcile what that says about siblings.
   * Never throws (beyond what {@link tripMultiReplicaDetected} deliberately
   * does), a transient DB blip here must not crash the process, which is the
   * OPPOSITE of this mechanism's job; it logs and waits for the next tick
   * instead.
   */
  private async heartbeatAndSweep(): Promise<void> {
    try {
      await this.heartbeats.upsert(
        { instanceId: this.instanceId, lastSeenAt: new Date() },
        ['instanceId'],
      );
      const staleBefore = new Date(
        Date.now() - HEARTBEAT_STALENESS_THRESHOLD_MS,
      );
      const freshRows = await this.heartbeats.find({
        where: { lastSeenAt: MoreThan(staleBefore) },
      });
      this.reconcilePeerObservations(freshRows);
    } catch (error) {
      this.logger.warn(
        `Chat gateway instance heartbeat/sweep failed (will retry in ` +
          `${HEARTBEAT_INTERVAL_MS}ms): ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  /**
   * The core of ENG-258's false-positive guard. `freshRows` is every
   * heartbeat row seen JUST NOW that is still within
   * {@link HEARTBEAT_STALENESS_THRESHOLD_MS}, including, on a completely
   * normal restart, the PREVIOUS boot's own row for a DIFFERENT instance id
   * (Railway mints a new `RAILWAY_REPLICA_ID` per container), which can
   * easily still read as "recent" for the first several ticks after this
   * process starts, purely because it was written shortly before the old
   * container stopped.
   *
   * Wall-clock recency alone therefore CANNOT tell "a genuinely live
   * sibling" apart from "a leftover row nobody is renewing anymore": both
   * look identical on a single observation. This method requires a SECOND
   * one: an id only ever joins {@link confirmedLiveSiblingIds} once its
   * `lastSeenAt` has been seen to advance STRICTLY forward between two of
   * this instance's own sweeps. A row nobody is renewing can never do that,
   * since its timestamp is frozen at whatever it was when its process
   * stopped, so it is impossible for a stale leftover to ever get confirmed, regardless
   * of how "fresh" the wall clock still considers it. A genuine second
   * replica, by contrast, renews its own row every `HEARTBEAT_INTERVAL_MS`
   * and gets confirmed within roughly two ticks of both processes being up
   * at once.
   *
   * Symmetrically, an id that falls OUT of `freshRows` (aged past the
   * staleness threshold with no renewal) is dropped from tracking entirely,
   * so a sibling that was once confirmed but has since genuinely gone away
   * stops counting.
   */
  private reconcilePeerObservations(
    freshRows: ChatGatewayInstanceHeartbeat[],
  ): void {
    const freshPeerIds = new Set<string>();
    for (const row of freshRows) {
      if (row.instanceId === this.instanceId) {
        continue;
      }
      freshPeerIds.add(row.instanceId);
      const observedMs = row.lastSeenAt.getTime();
      const previouslyObservedMs = this.lastObservedPeerHeartbeatMs.get(
        row.instanceId,
      );
      if (
        previouslyObservedMs !== undefined &&
        observedMs > previouslyObservedMs
      ) {
        this.confirmedLiveSiblingIds.add(row.instanceId);
      }
      this.lastObservedPeerHeartbeatMs.set(row.instanceId, observedMs);
    }
    for (const trackedId of this.lastObservedPeerHeartbeatMs.keys()) {
      if (!freshPeerIds.has(trackedId)) {
        this.lastObservedPeerHeartbeatMs.delete(trackedId);
        this.confirmedLiveSiblingIds.delete(trackedId);
      }
    }
    if (this.confirmedLiveSiblingIds.size > 0) {
      this.tripMultiReplicaDetected([...this.confirmedLiveSiblingIds]);
    }
  }

  /**
   * Fires the SAME failure path `onApplicationBootstrap`'s declared-count
   * check uses for a config that names more than one replica, matching the
   * behaviour ENG-258 asked for, "trip the same failure path… so the
   * behavior matches what ALLOW_MULTI_REPLICA already governs." The
   * declared-count path can `throw` because it runs during Nest's own
   * bootstrap sequence, which turns a thrown error into a failed, non-running
   * process; this path runs from a detached `setInterval` tick long after
   * bootstrap finished; an escaping throw there would surface only as an
   * `unhandledRejection` log line while the process (and its already-broken
   * presence/rooms/rate-limits) kept right on running, which is the exact
   * failure mode this whole mechanism exists to end. `process.exit(1)`
   * (already this codebase's own convention for a fatal condition detected
   * after boot, see `main.ts`) is what actually reaches the same outcome:
   * the process stops, and the deploy platform's own restart policy takes it
   * from there, a process manager cycling a genuinely single-replica
   * process (its sibling having gone away) simply reconfirms the invariant
   * on the very next boot's first, always-unconfirmed heartbeat sweep.
   *
   * Honours `ALLOW_MULTI_REPLICA` exactly like the declared-count path: an
   * operator who has explicitly acknowledged multiple replicas is
   * unaffected, even though the heartbeat keeps writing/observing regardless
   * (see `onApplicationBootstrap`'s comment for why the write itself stays
   * unconditional).
   */
  private tripMultiReplicaDetected(confirmedSiblingIds: string[]): void {
    if (
      isMultiReplicaAcknowledged(process.env[REPLICA_OVERRIDE_ENV_VARIABLE])
    ) {
      return;
    }
    this.logger.error(
      `Refusing to keep running: this chat gateway instance (${this.instanceId}) ` +
        `has detected ${confirmedSiblingIds.length} OTHER live instance(s) via the ` +
        `runtime heartbeat (${confirmedSiblingIds.join(', ')}), a scale-out that no ` +
        `declared replica count named, most likely done from the Railway dashboard ` +
        `directly. Presence, WS rate limits and socket.io rooms are process-local ` +
        `(see ChatSingleInstanceGuard's own doc for the full list), so this is not ` +
        `safe. Scale back to one replica, or wire a socket.io Redis adapter and ` +
        `shared presence/limit stores first. ${REPLICA_OVERRIDE_ENV_VARIABLE}=true ` +
        `overrides this, knowingly.`,
    );
    process.exit(1);
  }
}

/** `RAILWAY_REPLICA_ID` where present and non-blank, otherwise a fresh id
 *  minted once for this process's lifetime. Module-level (not a class method)
 *  so it runs exactly once, at class-field-initialisation time, rather than
 *  being re-derived anywhere. */
function resolveInstanceId(): string {
  const railwayReplicaId = process.env.RAILWAY_REPLICA_ID;
  if (railwayReplicaId !== undefined && railwayReplicaId.trim() !== '') {
    return railwayReplicaId.trim();
  }
  return randomUUID();
}
