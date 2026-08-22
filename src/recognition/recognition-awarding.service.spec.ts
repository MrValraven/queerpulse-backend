import { RecognitionAwardingService } from './recognition-awarding.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionLedgerEntry } from './entities/recognition-ledger-entry.entity';
import {
  RecognitionSignals,
  scoreSignals,
  badgeBonusXp,
} from './recognition.scoring';

type Stat = { userId: string; xp: number; updatedAt: Date };
type Award = { userId: string; badgeKey: string; context: string | null };
type LedgerRow = {
  userId: string;
  description: string;
  xp: number;
};

function makeService(opts: {
  stat?: Stat | null;
  awards?: Award[];
  signals: RecognitionSignals;
}) {
  const savedStats: Stat[] = [];
  const insertedAwards: Award[] = [];
  const insertedLedgerRows: LedgerRow[] = [];
  const notified: {
    type: NotificationType;
    payload: Record<string, unknown>;
  }[] = [];

  // `recompute` runs its whole read-modify-write inside
  // `stats.manager.transaction(...)` under a per-member advisory lock
  // (BE-COM-24), so awards/ledger/stat writes all go through the
  // transaction's `EntityManager` rather than through injected repositories.
  // This stub routes the three raw queries the service issues and hands back
  // the same award/ledger doubles the assertions below inspect.
  const managerStub = {
    query: (sql: string, params: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        return Promise.resolve([{ pg_advisory_xact_lock: '' }]);
      }
      if (sql.includes('SELECT xp FROM recognition_stats')) {
        return Promise.resolve(opts.stat ? [{ xp: opts.stat.xp }] : []);
      }
      // Mirrors the real atomic GREATEST upsert: resolves the max of the
      // currently stored xp and the computed xp passed as the 2nd param.
      const storedXp = opts.stat?.xp ?? 0;
      const computedXp = Number(params[1]);
      const resolvedXp = Math.max(storedXp, computedXp);
      savedStats.push({
        userId: params[0] as string,
        xp: resolvedXp,
        updatedAt: new Date(0),
      });
      return Promise.resolve([{ xp: resolvedXp }]);
    },
    getRepository: (entity: unknown) => {
      if (entity === RecognitionAward) return awardsRepo;
      if (entity === RecognitionLedgerEntry) return ledgerRepo;
      throw new Error(`unexpected entity in getRepository: ${String(entity)}`);
    },
  };

  const statsRepo = {
    findOne: () => Promise.resolve(opts.stat ?? null),
    save: (row: { userId: string; xp: number }) => {
      savedStats.push({ ...row, updatedAt: new Date(0) });
      return Promise.resolve(row);
    },
    manager: {
      transaction: (cb: (m: typeof managerStub) => Promise<unknown>) =>
        cb(managerStub),
    },
  };
  const awardsRepo = {
    find: () => Promise.resolve(opts.awards ?? []),
    createQueryBuilder: () => ({
      insert: () => ({
        values: (rows: Award[]) => ({
          orIgnore: () => ({
            execute: () => {
              insertedAwards.push(...rows);
              return Promise.resolve({ identifiers: [] });
            },
          }),
        }),
      }),
    }),
  };
  const ledgerRepo = {
    insert: (rows: LedgerRow[]) => {
      insertedLedgerRows.push(...rows);
      return Promise.resolve({ identifiers: [] });
    },
  };
  const profilesRepo = {
    findOne: () => Promise.resolve({ avatarUrl: 'x', bio: 'hi' }),
  };
  const communityMembersRepo = { count: () => Promise.resolve(0) };
  const savedItemsRepo = {
    count: (query: { where: { subjectType: string } }) => {
      if (query.where.subjectType === 'listing') {
        return Promise.resolve(opts.signals.listingsSaved);
      }
      if (query.where.subjectType === 'article') {
        return Promise.resolve(opts.signals.articlesSaved);
      }
      return Promise.resolve(0);
    },
  };
  const memberPreferencesRepo = {
    findOne: () =>
      Promise.resolve(
        opts.signals.workProfileComplete
          ? { skills: ['branding'], focusAreas: ['mentorship'] }
          : { skills: [], focusAreas: [] },
      ),
  };
  const eligibility = {
    getSignals: () => Promise.resolve(signalsToDto(opts.signals)),
  };
  const notifications = {
    create: (
      _userId: string,
      type: NotificationType,
      payload: Record<string, unknown>,
    ) => {
      notified.push({ type, payload });
      return Promise.resolve(null);
    },
  };

  const service = new RecognitionAwardingService(
    statsRepo as never,
    profilesRepo as never,
    communityMembersRepo as never,
    savedItemsRepo as never,
    memberPreferencesRepo as never,
    eligibility as never,
    notifications as never,
  );
  return { service, savedStats, insertedAwards, insertedLedgerRows, notified };
}

// Minimal PublicEligibilitySignalsDto stand-in: only the fields gatherSignals reads.
function signalsToDto(signals: RecognitionSignals) {
  return {
    verified: signals.verified,
    tenureDays: signals.tenureDays,
    // Inbound vouchCount isn't read by gatherSignals; it derives its own
    // `vouchCount` (an outbound signal, see recognition-awarding.service.ts)
    // from the DTO's `vouchesGivenCount` field.
    vouchCount: 0,
    vouchesGivenCount: signals.vouchCount,
    endorsementCount: signals.endorsementCount,
    connectionCount: signals.connectionCount,
    eventsAttended: signals.eventsAttended,
    communityPosts: signals.communityPosts,
    workshopsTaught: signals.workshopsTaught,
    publishedSubprofiles: signals.personasPublished,
  };
}

const BASE: RecognitionSignals = {
  profileComplete: true,
  communitiesJoined: 0,
  personasPublished: 0,
  vouchCount: 0,
  connectionCount: 0,
  eventsAttended: 0,
  communityPosts: 0,
  endorsementCount: 0,
  workshopsTaught: 0,
  tenureDays: 0,
  verified: false,
  gettingStartedStepsDone: 1,
  gettingStartedComplete: false,
  listingsSaved: 0,
  articlesSaved: 0,
  workProfileComplete: false,
};

const USER = { userId: 'u1', status: 'active' } as never;

describe('RecognitionAwardingService.recompute', () => {
  it('writes computed XP for a fresh user and inserts earned badges', async () => {
    const { service, savedStats, insertedAwards } = makeService({
      stat: null,
      awards: [],
      signals: { ...BASE, eventsAttended: 1 }, // first-gathering qualifies
    });
    const result = await service.recompute(USER, { force: true });
    expect(result.xpAfter).toBeGreaterThan(0);
    expect(savedStats[0]!.xp).toBe(result.xpAfter);
    expect(insertedAwards.map((a) => a.badgeKey)).toContain('first-gathering');
  });

  it('never lets XP regress below the stored value', async () => {
    const { service, savedStats } = makeService({
      stat: { userId: 'u1', xp: 5000, updatedAt: new Date(0) },
      awards: [],
      signals: BASE, // computes far less than 5000
    });
    const result = await service.recompute(USER, { force: true });
    expect(result.xpAfter).toBe(5000);
    expect(savedStats[0]!.xp).toBe(5000);
  });

  it('does not re-insert an already-earned badge (idempotent)', async () => {
    const { service, insertedAwards } = makeService({
      stat: { userId: 'u1', xp: 0, updatedAt: new Date(0) },
      awards: [{ userId: 'u1', badgeKey: 'first-gathering', context: null }],
      signals: { ...BASE, eventsAttended: 1 },
    });
    const result = await service.recompute(USER, { force: true });
    expect(insertedAwards).toHaveLength(0);
    expect(result.newBadgeKeys).not.toContain('first-gathering');
  });

  it('keeps a badge earned even after its signal drops (stickiness)', async () => {
    const stickinessSignals: RecognitionSignals = {
      ...BASE,
      eventsAttended: 0,
    }; // no longer qualifies
    const { service, insertedAwards } = makeService({
      stat: { userId: 'u1', xp: 0, updatedAt: new Date(0) },
      awards: [{ userId: 'u1', badgeKey: 'regular-attendee', context: null }],
      signals: stickinessSignals,
    });
    const result = await service.recompute(USER, { force: true });
    // Not removed and not re-inserted.
    expect(insertedAwards).toHaveLength(0);
    // The sticky badge's rarity bonus must still be counted in XP, not just
    // the recomputed signal score, or a regression here would silently drop
    // the bonus without insertedAwards catching it.
    expect(result.xpAfter).toBe(
      scoreSignals(stickinessSignals) + badgeBonusXp(['regular-attendee']),
    );
  });

  it('notifies on level-up and on each new badge', async () => {
    const { service, notified } = makeService({
      stat: { userId: 'u1', xp: 0, updatedAt: new Date(0) },
      awards: [],
      signals: {
        ...BASE,
        eventsAttended: 12,
        connectionCount: 25,
        vouchCount: 10,
        communityPosts: 20,
      },
    });
    await service.recompute(USER, { force: true });
    expect(notified.some((n) => n.type === NotificationType.XpLevelUp)).toBe(
      true,
    );
    expect(notified.some((n) => n.type === NotificationType.BadgeEarned)).toBe(
      true,
    );
  });

  it('awards local-scout and well-read from saved-item counts', async () => {
    const { service, insertedAwards } = makeService({
      stat: { userId: 'u1', xp: 0, updatedAt: new Date(0) },
      awards: [],
      signals: { ...BASE, listingsSaved: 3, articlesSaved: 5 },
    });
    const result = await service.recompute(USER, { force: true });
    expect(result.newBadgeKeys).toEqual(
      expect.arrayContaining(['local-scout', 'well-read']),
    );
    expect(insertedAwards.map((a) => a.badgeKey)).toEqual(
      expect.arrayContaining(['local-scout', 'well-read']),
    );
  });

  it('awards work-ready once skills and focus areas are set', async () => {
    const { service, insertedAwards } = makeService({
      stat: { userId: 'u1', xp: 0, updatedAt: new Date(0) },
      awards: [],
      signals: { ...BASE, workProfileComplete: true },
    });
    const result = await service.recompute(USER, { force: true });
    expect(result.newBadgeKeys).toContain('work-ready');
    expect(insertedAwards.map((a) => a.badgeKey)).toContain('work-ready');
  });

  it('skips recompute when stat was updated within the TTL and not forced', async () => {
    const { service, savedStats } = makeService({
      stat: { userId: 'u1', xp: 100, updatedAt: new Date() },
      awards: [],
      signals: { ...BASE, eventsAttended: 12 },
    });
    const result = await service.recompute(USER); // no force
    expect(result.xpAfter).toBe(100);
    expect(savedStats).toHaveLength(0);
  });

  describe('XP ledger', () => {
    it('writes one precise row per newly-earned badge, worth its rarity bonus', async () => {
      const { service, insertedLedgerRows } = makeService({
        stat: null,
        awards: [],
        signals: { ...BASE, eventsAttended: 1 }, // first-gathering (common, +40)
      });
      await service.recompute(USER, { force: true });
      expect(insertedLedgerRows).toContainEqual({
        userId: 'u1',
        description: 'Badge earned: First Gathering',
        xp: 40,
      });
    });

    it('writes a generic activity row for signal-driven XP growth beyond any new badge bonus', async () => {
      const { service, insertedLedgerRows } = makeService({
        stat: { userId: 'u1', xp: 0, updatedAt: new Date(0) },
        awards: [],
        signals: BASE, // profileComplete: true => 50 XP, no badge qualifies
      });
      const result = await service.recompute(USER, { force: true });
      expect(insertedLedgerRows).toContainEqual({
        userId: 'u1',
        description: 'Recognition recalculated from recent activity',
        xp: result.xpAfter,
      });
    });

    it('writes nothing when a recompute finds no XP growth', async () => {
      const { service, insertedLedgerRows } = makeService({
        stat: { userId: 'u1', xp: 5000, updatedAt: new Date(0) },
        awards: [],
        signals: BASE, // computes far less than the stored 5000
      });
      await service.recompute(USER, { force: true });
      expect(insertedLedgerRows).toHaveLength(0);
    });
  });
});
