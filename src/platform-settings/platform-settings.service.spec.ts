import { Repository } from 'typeorm';
import { PlatformSettingsService } from './platform-settings.service';
import {
  PlatformSettings,
  PLATFORM_SETTINGS_ID,
} from './entities/platform-settings.entity';
import { PlatformSettingChange } from './entities/platform-setting-change.entity';
import { Profile } from '../users/entities/profile.entity';

/**
 * Built through `Object.assign(new PlatformSettings(), ...)` rather than as an
 * object literal because `get()` now returns a prototype-preserving copy of the
 * cached row, and a fixture that was never a `PlatformSettings` would not
 * exercise that.
 */
function makeRow(overrides: Partial<PlatformSettings> = {}): PlatformSettings {
  return Object.assign(new PlatformSettings(), {
    id: PLATFORM_SETTINGS_ID,
    registrationEnabled: true,
    joinRequestsEnabled: true,
    lockdownEnabled: false,
    lockdownAllowsModerators: false,
    lockdownMessage: null,
    registrationClosedMessage: null,
    announcementEnabled: false,
    announcementMessage: null,
    announcementExpiresAt: null,
    announcementVersion: 'seed-version-0000-0000-000000000000',
    updatedAt: new Date('2026-07-19T00:00:00Z'),
    updatedBy: null,
    ...overrides,
  });
}

describe('PlatformSettingsService', () => {
  let settingsRepo: jest.Mocked<Pick<Repository<PlatformSettings>, 'findOne'>>;
  let changesRepo: jest.Mocked<
    Pick<Repository<PlatformSettingChange>, 'findAndCount'>
  >;
  let profilesRepo: jest.Mocked<Pick<Repository<Profile>, 'find'>>;
  let manager: {
    findOneOrFail: jest.Mock;
    create: jest.Mock<unknown, [unknown, unknown]>;
    save: jest.Mock<unknown, [unknown]>;
  };
  let dataSource: { transaction: jest.Mock };
  let events: { emit: jest.Mock };
  let service: PlatformSettingsService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-19T12:00:00Z'));

    settingsRepo = { findOne: jest.fn() };
    changesRepo = { findAndCount: jest.fn() };
    profilesRepo = { find: jest.fn() };
    manager = {
      findOneOrFail: jest.fn(),
      create: jest.fn((_entity: unknown, data: unknown) => data),
      save: jest.fn((arg: unknown) => arg),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    events = { emit: jest.fn() };

    service = new PlatformSettingsService(
      settingsRepo as never,
      changesRepo as never,
      profilesRepo as never,
      dataSource as never,
      events as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('reads the singleton row on first call', async () => {
      const row = makeRow();
      settingsRepo.findOne.mockResolvedValue(row);

      await expect(service.get()).resolves.toEqual(row);
      expect(settingsRepo.findOne).toHaveBeenCalledWith({
        where: { id: PLATFORM_SETTINGS_ID },
      });
    });

    it('serves the cache inside the TTL without hitting the database again', async () => {
      settingsRepo.findOne.mockResolvedValue(makeRow());

      await service.get();
      jest.advanceTimersByTime(9_000);
      await service.get();

      expect(settingsRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('refetches once the TTL has expired', async () => {
      settingsRepo.findOne.mockResolvedValue(makeRow());

      await service.get();
      jest.advanceTimersByTime(10_001);
      await service.get();

      expect(settingsRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it('throws loudly when the seeded row is missing rather than defaulting to unlocked', async () => {
      settingsRepo.findOne.mockResolvedValue(null);

      await expect(service.get()).rejects.toThrow(
        /Service temporarily unavailable/,
      );
    });

    it('serves the last known good copy when the query fails after the TTL lapsed', async () => {
      // A connection blip must not 500 every non-exempt route through
      // PlatformLockdownGuard just because a perfectly good cached copy aged out.
      const row = makeRow({ lockdownEnabled: true });
      settingsRepo.findOne.mockResolvedValue(row);
      await service.get();

      jest.advanceTimersByTime(10_001);
      settingsRepo.findOne.mockRejectedValue(
        new Error('connection terminated'),
      );

      await expect(service.get()).resolves.toEqual(row);
      expect(settingsRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it('propagates the query error when there is no cached copy to fall back to', async () => {
      settingsRepo.findOne.mockRejectedValue(
        new Error('connection terminated'),
      );

      await expect(service.get()).rejects.toThrow('connection terminated');
    });

    it('keeps retrying the database while degraded rather than pinning the stale copy', async () => {
      const stale = makeRow();
      settingsRepo.findOne.mockResolvedValue(stale);
      await service.get();

      jest.advanceTimersByTime(10_001);
      settingsRepo.findOne.mockRejectedValue(new Error('pool exhausted'));
      await expect(service.get()).resolves.toEqual(stale);

      // Serving the fallback must not refresh `cachedAt` — otherwise a blip
      // would freeze the kill switch for a further full TTL after recovery.
      const fresh = makeRow({ lockdownEnabled: true });
      settingsRepo.findOne.mockResolvedValue(fresh);
      await expect(service.get()).resolves.toEqual(fresh);
    });

    // ENG-44. Callers receive an entity, and the ordinary thing to do with an
    // entity is assign to a field on it. On the shared cached instance that
    // would rewrite the platform's lockdown state for every concurrent request
    // until the TTL lapsed.
    it('hands out a copy, so a caller mutating what it received cannot rewrite the cache', async () => {
      settingsRepo.findOne.mockResolvedValue(
        makeRow({ lockdownEnabled: true }),
      );

      const first = await service.get();
      first.lockdownEnabled = false;
      first.lockdownMessage = 'mutated by a caller';

      const second = await service.get();
      expect(second.lockdownEnabled).toBe(true);
      expect(second.lockdownMessage).toBeNull();
      // Still one read: the copy comes off the cache, it does not defeat it.
      expect(settingsRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('returns a real PlatformSettings, not a bare object', async () => {
      // The copy is handed back as the entity type, so the prototype has to
      // survive it — a spread would satisfy the compiler and fail instanceof.
      settingsRepo.findOne.mockResolvedValue(makeRow());

      await expect(service.get()).resolves.toBeInstanceOf(PlatformSettings);
    });
  });

  // ENG-50. A bare array left an admin unable to tell a last page from a
  // truncated one.
  describe('listChanges', () => {
    function makeChange(
      overrides: Partial<PlatformSettingChange> = {},
    ): PlatformSettingChange {
      return Object.assign(new PlatformSettingChange(), {
        id: 'chg-1',
        actorId: 'admin-1',
        settingKey: 'lockdownEnabled',
        oldValue: 'false',
        newValue: 'true',
        note: null,
        createdAt: new Date('2026-07-19T11:00:00Z'),
        ...overrides,
      });
    }

    it('answers with the Paginated envelope carrying the real total', async () => {
      changesRepo.findAndCount.mockResolvedValue([[makeChange()], 137]);
      profilesRepo.find.mockResolvedValue([]);

      const result = await service.listChanges(50, 100);

      expect(result.total).toBe(137);
      expect(result.items).toHaveLength(1);
      // page/pageSize are derived from the endpoint's limit/offset contract.
      expect(result.pageSize).toBe(50);
      expect(result.page).toBe(3);
    });

    it('breaks createdAt ties by id so a window cannot shift under a caller', async () => {
      changesRepo.findAndCount.mockResolvedValue([[], 0]);
      profilesRepo.find.mockResolvedValue([]);

      await service.listChanges(50, 0);

      expect(changesRepo.findAndCount).toHaveBeenCalledWith({
        order: { createdAt: 'DESC', id: 'DESC' },
        take: 50,
        skip: 0,
      });
    });

    it('resolves the actor to a display shape and never ships the raw id', async () => {
      changesRepo.findAndCount.mockResolvedValue([[makeChange()], 1]);
      profilesRepo.find.mockResolvedValue([
        {
          userId: 'admin-1',
          slug: 'ada',
          firstName: 'Ada',
          lastName: 'Lovelace',
          pronouns: 'she/her',
          avatarUrl: null,
          photoVisible: true,
        },
      ] as never);

      const result = await service.listChanges(50, 0);

      expect(result.items[0]?.actor).toMatchObject({
        slug: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      expect(result.items[0]).not.toHaveProperty('actorId');
    });

    it('reports a null actor for an erased admin without looking the NULL up', async () => {
      changesRepo.findAndCount.mockResolvedValue([
        [makeChange({ actorId: null })],
        1,
      ]);

      const result = await service.listChanges(50, 0);

      expect(result.items[0]?.actor).toBeNull();
      // No non-null id to resolve, so no profile query at all.
      expect(profilesRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('writes one audit row per changed field', async () => {
      manager.findOneOrFail.mockResolvedValue(makeRow());

      await service.update(
        { lockdownEnabled: true, registrationEnabled: false },
        'admin-1',
      );

      const savedChanges = manager.save.mock.calls
        .map(([arg]) => arg)
        .find((arg) => Array.isArray(arg)) as PlatformSettingChange[];

      expect(savedChanges).toHaveLength(2);
      expect(savedChanges.map((c) => c.settingKey).sort()).toEqual([
        'lockdownEnabled',
        'registrationEnabled',
      ]);
      const lockdown = savedChanges.find(
        (c) => c.settingKey === 'lockdownEnabled',
      );
      expect(lockdown).toMatchObject({
        actorId: 'admin-1',
        oldValue: 'false',
        newValue: 'true',
      });
    });

    it('writes no audit row for a field submitted with an unchanged value', async () => {
      manager.findOneOrFail.mockResolvedValue(makeRow());

      await service.update({ registrationEnabled: true }, 'admin-1');

      const savedChanges = manager.save.mock.calls
        .map(([arg]) => arg)
        .find((arg) => Array.isArray(arg));
      expect(savedChanges).toBeUndefined();
    });

    it('records the note on every audit row it writes', async () => {
      manager.findOneOrFail.mockResolvedValue(makeRow());

      await service.update(
        {
          lockdownEnabled: true,
          joinRequestsEnabled: false,
          note: 'spam wave',
        },
        'admin-1',
      );

      const savedChanges = manager.save.mock.calls
        .map(([arg]) => arg)
        .find((arg) => Array.isArray(arg)) as PlatformSettingChange[];
      expect(savedChanges.every((c) => c.note === 'spam wave')).toBe(true);
    });

    it('stamps updatedBy with the acting admin', async () => {
      manager.findOneOrFail.mockResolvedValue(makeRow());

      await service.update({ lockdownEnabled: true }, 'admin-7');

      const savedRow = manager.save.mock.calls
        .map(([arg]) => arg)
        .find((arg) => !Array.isArray(arg)) as PlatformSettings;
      expect(savedRow.updatedBy).toBe('admin-7');
    });

    it('busts the cache so the next get() sees the new value', async () => {
      settingsRepo.findOne.mockResolvedValue(makeRow());
      await service.get();
      expect(settingsRepo.findOne).toHaveBeenCalledTimes(1);

      manager.findOneOrFail.mockResolvedValue(makeRow());
      await service.update({ lockdownEnabled: true }, 'admin-1');

      settingsRepo.findOne.mockResolvedValue(
        makeRow({ lockdownEnabled: true }),
      );
      const after = await service.get();

      expect(settingsRepo.findOne).toHaveBeenCalledTimes(2);
      expect(after.lockdownEnabled).toBe(true);
    });

    it('leaves the cache intact when the transaction throws', async () => {
      settingsRepo.findOne.mockResolvedValue(makeRow());
      await service.get();

      dataSource.transaction.mockRejectedValue(new Error('deadlock'));
      await expect(
        service.update({ lockdownEnabled: true }, 'admin-1'),
      ).rejects.toThrow('deadlock');

      await service.get();
      // Still 1: a failed write must not force a refetch, and must not leave a
      // half-applied value cached.
      expect(settingsRepo.findOne).toHaveBeenCalledTimes(1);
    });

    // The audit trail's risky case: `null` (clear it) and `undefined` (leave it
    // alone) are different instructions that both look "empty".
    describe('message-field audit semantics', () => {
      const auditRowsFrom = (): PlatformSettingChange[] | undefined =>
        manager.save.mock.calls
          .map(([arg]) => arg)
          .find((arg) => Array.isArray(arg)) as
          PlatformSettingChange[] | undefined;

      it('writes one audit row with newValue null when a message is cleared', async () => {
        manager.findOneOrFail.mockResolvedValue(
          makeRow({ lockdownMessage: 'Back in an hour.' }),
        );

        await service.update({ lockdownMessage: null }, 'admin-1');

        const rows = auditRowsFrom();
        expect(rows).toHaveLength(1);
        expect(rows![0]).toMatchObject({
          settingKey: 'lockdownMessage',
          oldValue: 'Back in an hour.',
          newValue: null,
        });
      });

      it('writes no audit row when null is submitted for an already-null message', async () => {
        manager.findOneOrFail.mockResolvedValue(
          makeRow({ lockdownMessage: null }),
        );

        await service.update({ lockdownMessage: null }, 'admin-1');

        expect(auditRowsFrom()).toBeUndefined();
      });

      it('writes no audit row when the message field is omitted entirely', async () => {
        manager.findOneOrFail.mockResolvedValue(
          makeRow({ lockdownMessage: 'Back in an hour.' }),
        );

        // `undefined` means "leave alone" — it must not be read as "clear it".
        await service.update({ note: 'unrelated' }, 'admin-1');

        expect(auditRowsFrom()).toBeUndefined();
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('normalises an empty string to null in both the row and the audit', async () => {
        // An admin clearing the textarea sends '' — storing it would leave a
        // value that is neither a message nor absent, defeating the `||`
        // fallbacks at the guard and join-request read sites.
        const row = makeRow({ lockdownMessage: 'Back in an hour.' });
        manager.findOneOrFail.mockResolvedValue(row);

        await service.update({ lockdownMessage: '' }, 'admin-1');

        const rows = auditRowsFrom();
        expect(rows).toHaveLength(1);
        expect(rows?.[0]?.newValue).toBeNull();
        const savedRow = manager.save.mock.calls
          .map(([arg]) => arg)
          .find((arg) => !Array.isArray(arg)) as PlatformSettings;
        expect(savedRow.lockdownMessage).toBeNull();
      });
    });

    describe('lockdown-enabled event', () => {
      it('emits on a false -> true transition so live sockets can be dropped', async () => {
        manager.findOneOrFail.mockResolvedValue(
          makeRow({ lockdownEnabled: false }),
        );

        await service.update({ lockdownEnabled: true }, 'admin-1');

        expect(events.emit).toHaveBeenCalledWith('platform.lockdown.enabled', {
          actorId: 'admin-1',
        });
      });

      it('does not emit when lockdown was already on', async () => {
        manager.findOneOrFail.mockResolvedValue(
          makeRow({ lockdownEnabled: true }),
        );

        // A real change (so the write happens) that is not the transition.
        await service.update(
          { lockdownEnabled: true, lockdownAllowsModerators: true },
          'admin-1',
        );

        expect(events.emit).not.toHaveBeenCalled();
      });

      it('does not emit for an unrelated setting change', async () => {
        manager.findOneOrFail.mockResolvedValue(makeRow());

        await service.update({ registrationEnabled: false }, 'admin-1');

        expect(events.emit).not.toHaveBeenCalled();
      });

      it('does not emit when the transaction throws', async () => {
        dataSource.transaction.mockRejectedValue(new Error('deadlock'));

        await expect(
          service.update({ lockdownEnabled: true }, 'admin-1'),
        ).rejects.toThrow('deadlock');

        expect(events.emit).not.toHaveBeenCalled();
      });
    });
  });
});
