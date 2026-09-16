import { Logger } from '@nestjs/common';
import {
  ChatSingleInstanceGuard,
  HEARTBEAT_INTERVAL_MS,
} from './chat-single-instance.guard';
import { REPLICA_OVERRIDE_ENV_VARIABLE } from './chat-replica-signals';
import { ChatGatewayInstanceHeartbeat } from './entities/chat-gateway-instance-heartbeat.entity';

const REPLICA_ENV_KEYS = [
  'REPLICA_COUNT',
  'WEB_CONCURRENCY',
  REPLICA_OVERRIDE_ENV_VARIABLE,
  'RAILWAY_REPLICA_ID',
] as const;

/** A minimal row builder: `lastSeenAt` as a `Date`, matching what
 *  `Repository.find` actually hands back (never a raw string). */
function heartbeatRow(
  instanceId: string,
  lastSeenAt: Date,
): ChatGatewayInstanceHeartbeat {
  return { instanceId, lastSeenAt };
}

describe('ChatSingleInstanceGuard', () => {
  let guard: ChatSingleInstanceGuard;
  let heartbeats: {
    upsert: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
  };
  const originalValues: Record<string, string | undefined> = {};
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const key of REPLICA_ENV_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
    heartbeats = {
      upsert: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    guard = new ChatSingleInstanceGuard(heartbeats as never);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    // `tripMultiReplicaDetected` calls this for real on a confirmed sibling;
    // it must never actually kill the Jest worker process. A plain no-op
    // (rather than a throw) keeps the calling code's own control flow
    // exactly as it runs in production, where `process.exit` never returns.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      return undefined as never;
    });
  });

  afterEach(async () => {
    // Stop whatever interval `onApplicationBootstrap` armed so it cannot fire
    // (and touch the now-restored env / a torn-down spy) after the test ends.
    await guard.onModuleDestroy();
    for (const key of REPLICA_ENV_KEYS) {
      const original = originalValues[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    jest.useRealTimers();
  });

  it('boots when no replica count is declared at all', async () => {
    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('single-instance mode'),
    );
    // The very first sweep upserts this instance's own row.
    expect(heartbeats.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: expect.any(String) }),
      ['instanceId'],
    );
  });

  it('boots when REPLICA_COUNT is explicitly 1', async () => {
    process.env.REPLICA_COUNT = '1';
    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('throws when REPLICA_COUNT declares more than one replica and the override is absent', async () => {
    process.env.REPLICA_COUNT = '2';
    await expect(guard.onApplicationBootstrap()).rejects.toThrow(
      /safe on exactly ONE/,
    );
    // The declared-count throw happens BEFORE the heartbeat is ever touched.
    expect(heartbeats.upsert).not.toHaveBeenCalled();
  });

  it('throws the same way when WEB_CONCURRENCY is the variable declaring more than one worker', async () => {
    process.env.WEB_CONCURRENCY = '2';
    await expect(guard.onApplicationBootstrap()).rejects.toThrow(
      /safe on exactly ONE/,
    );
  });

  it('does not throw once ALLOW_MULTI_REPLICA is exactly "true", and warns instead', async () => {
    process.env.REPLICA_COUNT = '2';
    process.env[REPLICA_OVERRIDE_ENV_VARIABLE] = 'true';
    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('single-replica assertion'),
    );
    // The guard returns right after the warn, so the single-instance-mode log
    // line (only reached on the plain boot path) must be skipped entirely.
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('single-instance mode'),
    );
  });

  it.each(['TRUE', '1'])(
    'ALLOW_MULTI_REPLICA=%s is NOT the override: the guard still throws',
    async (looseTruthyValue) => {
      process.env.REPLICA_COUNT = '2';
      process.env[REPLICA_OVERRIDE_ENV_VARIABLE] = looseTruthyValue;
      await expect(guard.onApplicationBootstrap()).rejects.toThrow(
        /safe on exactly ONE/,
      );
    },
  );

  it('on Railway with no declared replica count, warns about the config-only blind spot and boots', async () => {
    process.env.RAILWAY_REPLICA_ID = 'replica-abc123';
    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Running on Railway'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('single-instance mode'),
    );
  });

  it('on Railway WITH a declared replica count over one, still throws (Railway presence never overrides a real count)', async () => {
    process.env.RAILWAY_REPLICA_ID = 'replica-abc123';
    process.env.REPLICA_COUNT = '2';
    await expect(guard.onApplicationBootstrap()).rejects.toThrow(
      /safe on exactly ONE/,
    );
  });

  describe('runtime heartbeat detection (ENG-258)', () => {
    // `instanceId` is resolved once, as a class-field initialiser, at
    // CONSTRUCTION time, so `RAILWAY_REPLICA_ID` must be set BEFORE `new
    // ChatSingleInstanceGuard(...)` runs, ahead of when
    // `onApplicationBootstrap()` itself runs. The shared top-level `beforeEach` already
    // constructed a `guard` with no `RAILWAY_REPLICA_ID` (a random uuid), so
    // each test below builds its OWN guard, after setting the env var, and
    // uses that instead of the shared one.
    let ownGuard: ChatSingleInstanceGuard;

    afterEach(async () => {
      await ownGuard?.onModuleDestroy();
    });

    it('trips (logs and exits) once a SECOND instance is confirmed genuinely live across two sweeps', async () => {
      jest.useFakeTimers();
      process.env.RAILWAY_REPLICA_ID = 'me';
      ownGuard = new ChatSingleInstanceGuard(heartbeats as never);
      const t0 = new Date('2026-09-16T00:00:00.000Z');
      const t1 = new Date('2026-09-16T00:00:20.000Z'); // one heartbeat tick later

      // First sweep (inside `onApplicationBootstrap`): a sibling row is
      // ALREADY present, e.g. it booted moments earlier, but this is only
      // ever a first sighting, so it must not trip anything by itself.
      heartbeats.find.mockResolvedValueOnce([
        heartbeatRow('me', t0),
        heartbeatRow('sibling', t0),
      ]);
      await ownGuard.onApplicationBootstrap();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      // Second sweep, one interval later: the sibling's OWN row has genuinely
      // advanced (it is still alive and renewing it), which is the one
      // signal that confirms a live sibling.
      heartbeats.find.mockResolvedValueOnce([
        heartbeatRow('me', t1),
        heartbeatRow('sibling', t1),
      ]);
      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      // Flush the async `heartbeatAndSweep` chain the fired timer kicked off
      // (upsert -> find -> reconcile -> trip -> process.exit).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sibling'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('never trips on a stale row left behind by a previous, now-dead boot', async () => {
      jest.useFakeTimers();
      process.env.RAILWAY_REPLICA_ID = 'new-instance';
      ownGuard = new ChatSingleInstanceGuard(heartbeats as never);
      // `old-instance` is a DIFFERENT id (Railway mints a fresh
      // `RAILWAY_REPLICA_ID` per container), whose process has already
      // stopped, so nobody is renewing its row: its `lastSeenAt` is frozen at
      // the same value on every sweep below, even though it is still well
      // inside the staleness window (a normal, fast restart).
      const frozenStaleTimestamp = new Date('2026-09-16T00:00:05.000Z');

      heartbeats.find.mockImplementation(() =>
        Promise.resolve([
          heartbeatRow('new-instance', new Date()),
          heartbeatRow('old-instance', frozenStaleTimestamp),
        ]),
      );
      await ownGuard.onApplicationBootstrap();
      expect(exitSpy).not.toHaveBeenCalled();

      // Several more sweeps: `old-instance`'s timestamp NEVER advances (its
      // process is gone), so it can never be confirmed, no matter how many
      // ticks pass while it still happens to read as "recent".
      for (let tick = 0; tick < 4; tick += 1) {
        jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
