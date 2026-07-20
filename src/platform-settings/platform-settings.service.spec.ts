import { Repository } from 'typeorm';
import { PlatformSettingsService } from './platform-settings.service';
import {
  PlatformSettings,
  PLATFORM_SETTINGS_ID,
} from './entities/platform-settings.entity';
import { PlatformSettingChange } from './entities/platform-setting-change.entity';

function makeRow(overrides: Partial<PlatformSettings> = {}): PlatformSettings {
  return {
    id: PLATFORM_SETTINGS_ID,
    registrationEnabled: true,
    joinRequestsEnabled: true,
    lockdownEnabled: false,
    lockdownAllowsModerators: false,
    lockdownMessage: null,
    registrationClosedMessage: null,
    updatedAt: new Date('2026-07-19T00:00:00Z'),
    updatedBy: null,
    ...overrides,
  } as PlatformSettings;
}

describe('PlatformSettingsService', () => {
  let settingsRepo: jest.Mocked<Pick<Repository<PlatformSettings>, 'findOne'>>;
  let changesRepo: jest.Mocked<Pick<Repository<PlatformSettingChange>, 'find'>>;
  let manager: {
    findOneOrFail: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let events: { emit: jest.Mock };
  let service: PlatformSettingsService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-19T12:00:00Z'));

    settingsRepo = { findOne: jest.fn() } as never;
    changesRepo = { find: jest.fn() } as never;
    manager = {
      findOneOrFail: jest.fn(),
      create: jest.fn((_entity, data) => data),
      save: jest.fn((arg) => arg),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    events = { emit: jest.fn() };

    service = new PlatformSettingsService(
      settingsRepo as never,
      changesRepo as never,
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

      await expect(service.get()).resolves.toBe(row);
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

      await expect(service.get()).rejects.toThrow(/migration/i);
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

      await expect(service.get()).resolves.toBe(row);
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
      await expect(service.get()).resolves.toBe(stale);

      // Serving the fallback must not refresh `cachedAt` — otherwise a blip
      // would freeze the kill switch for a further full TTL after recovery.
      const fresh = makeRow({ lockdownEnabled: true });
      settingsRepo.findOne.mockResolvedValue(fresh);
      await expect(service.get()).resolves.toBe(fresh);
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
        expect(rows![0].newValue).toBeNull();
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
