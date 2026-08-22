import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

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
export class ChatSingleInstanceGuard implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChatSingleInstanceGuard.name);

  onApplicationBootstrap(): void {
    // Read straight off `process.env` rather than through `ConfigService`:
    // these are platform-injected deployment facts (Railway, Heroku, pm2), not
    // application settings, so none of them belongs in a config namespace or in
    // `env.validation.ts`.
    const acknowledged = this.isTruthy(process.env.CHAT_ALLOW_MULTI_INSTANCE);
    const declaredReplicas = this.declaredReplicaCount();

    if (declaredReplicas !== null && declaredReplicas > 1 && !acknowledged) {
      throw new Error(
        `Refusing to start: the chat gateway holds presence, WS rate limits and ` +
          `socket.io rooms in process memory, so it is safe on exactly ONE ` +
          `replica, but this environment declares ${declaredReplicas}. Live ` +
          `messages, revoked sessions and lockdown disconnects would each reach ` +
          `only the replica that handled the request. Scale back to one replica, ` +
          `or wire a socket.io Redis adapter and shared presence/limit stores ` +
          `first (see ChatSingleInstanceGuard's doc for the full list). ` +
          `CHAT_ALLOW_MULTI_INSTANCE=true overrides this, knowingly.`,
      );
    }

    if (acknowledged) {
      this.logger.warn(
        'CHAT_ALLOW_MULTI_INSTANCE is set: the single-replica assertion is ' +
          'disabled. Presence, WS rate limits, session revocation and every ' +
          'socket.io room emit remain process-local, so live chat is only ' +
          'correct if a shared adapter is in front of them.',
      );
      return;
    }

    this.logger.log(
      'Chat gateway running in single-instance mode: presence, WS rate limits ' +
        'and socket.io rooms are process-local. Do not scale this service past ' +
        'one replica without a socket.io Redis adapter.',
    );
  }

  /**
   * The replica count the platform declares, or `null` when nothing says.
   *
   * Deliberately only reads variables whose value IS a count. A platform that
   * exposes only "which replica am I" (Railway's `RAILWAY_REPLICA_ID`) says
   * nothing about how many there are, so guessing from it would refuse to boot
   * a perfectly fine single-replica deploy.
   */
  private declaredReplicaCount(): number | null {
    const countVariables = [
      'CHAT_REPLICA_COUNT',
      'RAILWAY_SERVICE_NUM_REPLICAS',
      'RAILWAY_REPLICA_COUNT',
      'WEB_CONCURRENCY',
      'INSTANCE_COUNT',
      'REPLICAS',
    ];
    for (const variable of countVariables) {
      const raw = process.env[variable];
      if (raw === undefined || raw.trim() === '') {
        continue;
      }
      const parsed = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return null;
  }

  private isTruthy(value: string | undefined): boolean {
    return (
      value !== undefined && ['1', 'true', 'yes'].includes(value.toLowerCase())
    );
  }
}
