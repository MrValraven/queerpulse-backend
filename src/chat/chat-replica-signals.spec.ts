import {
  REPLICA_OVERRIDE_ENV_VARIABLE,
  declaredReplicaCount,
  declaredReplicaCountFromProcessEnv,
  isMultiReplicaAcknowledged,
  isRunningOnRailwayWithUndeclaredReplicaCount,
} from './chat-replica-signals';

const REPLICA_ENV_KEYS = [
  'REPLICA_COUNT',
  'WEB_CONCURRENCY',
  'ALLOW_MULTI_REPLICA',
  'RAILWAY_REPLICA_ID',
] as const;

describe('chat-replica-signals', () => {
  it('the override variable is ALLOW_MULTI_REPLICA, the only knob both gates honour', () => {
    expect(REPLICA_OVERRIDE_ENV_VARIABLE).toBe('ALLOW_MULTI_REPLICA');
  });

  describe('declaredReplicaCount', () => {
    it('returns null when neither count is declared', () => {
      expect(declaredReplicaCount({})).toBeNull();
    });

    it('returns REPLICA_COUNT alone', () => {
      expect(declaredReplicaCount({ REPLICA_COUNT: 2 })).toBe(2);
    });

    it('returns WEB_CONCURRENCY alone', () => {
      expect(declaredReplicaCount({ WEB_CONCURRENCY: 3 })).toBe(3);
    });

    it('returns the LARGER of the two when both are declared', () => {
      expect(
        declaredReplicaCount({ REPLICA_COUNT: 2, WEB_CONCURRENCY: 5 }),
      ).toBe(5);
      expect(
        declaredReplicaCount({ REPLICA_COUNT: 7, WEB_CONCURRENCY: 1 }),
      ).toBe(7);
    });

    it('a single replica declared explicitly still returns 1', () => {
      expect(declaredReplicaCount({ REPLICA_COUNT: 1 })).toBe(1);
    });

    it('ignores non-positive or non-finite values, falling back to null when nothing valid is left', () => {
      expect(declaredReplicaCount({ REPLICA_COUNT: 0 })).toBeNull();
      expect(declaredReplicaCount({ REPLICA_COUNT: -1 })).toBeNull();
      expect(
        declaredReplicaCount({ REPLICA_COUNT: Number.POSITIVE_INFINITY }),
      ).toBeNull();
      expect(declaredReplicaCount({ REPLICA_COUNT: Number.NaN })).toBeNull();
    });

    it('an invalid REPLICA_COUNT does not hide a valid WEB_CONCURRENCY', () => {
      expect(
        declaredReplicaCount({ REPLICA_COUNT: 0, WEB_CONCURRENCY: 4 }),
      ).toBe(4);
    });
  });

  describe('declaredReplicaCountFromProcessEnv (and isMultiReplicaAcknowledged / isRunningOnRailwayWithUndeclaredReplicaCount, which also read process.env directly)', () => {
    const originalValues: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of REPLICA_ENV_KEYS) {
        originalValues[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of REPLICA_ENV_KEYS) {
        const original = originalValues[key];
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    });

    describe('declaredReplicaCountFromProcessEnv', () => {
      it('returns null when both variables are unset', () => {
        expect(declaredReplicaCountFromProcessEnv()).toBeNull();
      });

      it('parses REPLICA_COUNT', () => {
        process.env.REPLICA_COUNT = '2';
        expect(declaredReplicaCountFromProcessEnv()).toBe(2);
      });

      it('parses WEB_CONCURRENCY the same way', () => {
        process.env.WEB_CONCURRENCY = '2';
        expect(declaredReplicaCountFromProcessEnv()).toBe(2);
      });

      it('takes the larger of the two when both are set', () => {
        process.env.REPLICA_COUNT = '2';
        process.env.WEB_CONCURRENCY = '4';
        expect(declaredReplicaCountFromProcessEnv()).toBe(4);
      });

      it('treats a non-numeric or blank value as unset', () => {
        process.env.REPLICA_COUNT = 'not-a-number';
        expect(declaredReplicaCountFromProcessEnv()).toBeNull();

        process.env.REPLICA_COUNT = '   ';
        expect(declaredReplicaCountFromProcessEnv()).toBeNull();
      });

      it('trims surrounding whitespace before parsing', () => {
        process.env.REPLICA_COUNT = '  3  ';
        expect(declaredReplicaCountFromProcessEnv()).toBe(3);
      });
    });

    describe('isMultiReplicaAcknowledged', () => {
      it('accepts only the exact string "true"', () => {
        expect(isMultiReplicaAcknowledged('true')).toBe(true);
      });

      it('rejects "TRUE" (case matters, matching env.validation.ts and .env.example)', () => {
        expect(isMultiReplicaAcknowledged('TRUE')).toBe(false);
      });

      it('rejects "1", the other loose-truthy value operators might reach for', () => {
        expect(isMultiReplicaAcknowledged('1')).toBe(false);
      });

      it('rejects undefined and the empty string', () => {
        expect(isMultiReplicaAcknowledged(undefined)).toBe(false);
        expect(isMultiReplicaAcknowledged('')).toBe(false);
      });
    });

    describe('isRunningOnRailwayWithUndeclaredReplicaCount', () => {
      it('is true on Railway (RAILWAY_REPLICA_ID set) with no declared count', () => {
        process.env.RAILWAY_REPLICA_ID = 'replica-abc123';
        expect(isRunningOnRailwayWithUndeclaredReplicaCount()).toBe(true);
      });

      it('is false on Railway once a count IS declared', () => {
        process.env.RAILWAY_REPLICA_ID = 'replica-abc123';
        process.env.REPLICA_COUNT = '1';
        expect(isRunningOnRailwayWithUndeclaredReplicaCount()).toBe(false);
      });

      it('is false off Railway (RAILWAY_REPLICA_ID unset), regardless of the count', () => {
        expect(isRunningOnRailwayWithUndeclaredReplicaCount()).toBe(false);
      });

      it('treats a blank RAILWAY_REPLICA_ID the same as unset', () => {
        process.env.RAILWAY_REPLICA_ID = '   ';
        expect(isRunningOnRailwayWithUndeclaredReplicaCount()).toBe(false);
      });
    });
  });
});
