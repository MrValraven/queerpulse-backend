import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { AccountExportService } from './account-export.service';
import { AccountService, DEFAULT_EMAIL_PREFERENCES } from './account.service';
import { AccountDeactivation } from './entities/account-deactivation.entity';
import { AccountReauthToken } from './entities/account-reauth-token.entity';
import { DataExportJob } from './entities/data-export-job.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from './entities/deletion-request.entity';
import { DsarRequest } from './entities/dsar-request.entity';
import { EmailPreference } from './entities/email-preference.entity';

describe('AccountService', () => {
  let service: AccountService;
  let deletionRequests: {
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let dsarRequests: { find: jest.Mock; save: jest.Mock };
  let exportJobs: { findOne: jest.Mock; save: jest.Mock };
  let emailPreferences: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let reauthTokens: { save: jest.Mock; findOne: jest.Mock };
  let deactivations: { findOne: jest.Mock; save: jest.Mock };
  let exportService: { build: jest.Mock };
  let refreshTokens: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  // Stand-in for the `users` row the deactivation/deletion transactions read
  // and update. Tests set `users.u1.status` to drive the status a flow must
  // preserve, then assert on it after the call.
  let users: Record<string, { id: string; status: UserStatus }>;
  let dataSource: { transaction: jest.Mock };
  let events: { emit: jest.Mock };

  const now = new Date('2026-07-15T12:00:00.000Z');

  beforeEach(async () => {
    deletionRequests = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v: Partial<DeletionRequest>) =>
        Promise.resolve({
          id: v.id ?? 'del-1',
          userId: v.userId,
          status: v.status,
          scheduledFor: v.scheduledFor,
          reason: v.reason ?? null,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    };
    dsarRequests = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((v: Partial<DsarRequest>) =>
        Promise.resolve({ id: 'dsar-1', ...v }),
      ),
    };
    exportJobs = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v: Partial<DataExportJob>) =>
        Promise.resolve({ id: 'job-1', ...v }),
      ),
    };
    emailPreferences = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v: Partial<EmailPreference>) =>
        Promise.resolve({ id: 'pref-1', ...v }),
      ),
    };
    reauthTokens = {
      save: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
    };
    deactivations = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v: Partial<AccountDeactivation>) =>
        Promise.resolve({ id: 'deact-1', ...v }),
      ),
    };
    // The archive builder is exercised by its own suite; here it only has to
    // resolve so `AccountService` can be constructed.
    exportService = {
      build: jest
        .fn()
        .mockResolvedValue({ manifest: { schemaVersion: '1.0' } }),
    };
    refreshTokens = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v: Partial<RefreshToken>) => Promise.resolve(v)),
      update: jest.fn().mockResolvedValue(undefined),
    };

    users = { u1: { id: 'u1', status: UserStatus.Active } };

    // Deactivation/deletion must drop live sockets too — the access token still
    // carries `status: 'active'` until it expires, so the gateway needs telling.
    events = { emit: jest.fn() };

    // `dataSource.transaction(cb)` runs the callback immediately against a
    // fake EntityManager that routes by entity class onto the same repository
    // mocks the rest of this suite asserts against — so a test can keep
    // checking `deactivations.save(...)` while the service does its writes
    // through a manager.
    type Where = Record<string, unknown>;
    const manager = {
      findOne: jest.fn(
        (
          entity: unknown,
          options: { where: Where | Where[] },
        ): Promise<unknown> => {
          const where = Array.isArray(options.where)
            ? options.where[0]
            : options.where;
          if (entity === User) {
            return Promise.resolve(users[where.id as string] ?? null);
          }
          if (entity === AccountDeactivation) {
            return deactivations.findOne(options) as Promise<unknown>;
          }
          if (entity === DeletionRequest) {
            return deletionRequests.findOne(options) as Promise<unknown>;
          }
          throw new Error('unexpected entity in manager.findOne');
        },
      ),
      save: jest.fn((entity: unknown, value: unknown): Promise<unknown> => {
        if (entity === AccountDeactivation) {
          return deactivations.save(value) as Promise<unknown>;
        }
        if (entity === DeletionRequest) {
          return deletionRequests.save(value) as Promise<unknown>;
        }
        throw new Error('unexpected entity in manager.save');
      }),
      update: jest.fn(
        (
          entity: unknown,
          criteria: { id: string; status?: UserStatus },
          patch: { status: UserStatus },
        ) => {
          if (entity !== User) {
            return Promise.resolve({ affected: 1 });
          }
          const row = users[criteria.id];
          // Mirror the real conditional-claim semantics: an `update` with a
          // `status` in the criteria only applies when it still matches.
          if (
            row &&
            (criteria.status === undefined || row.status === criteria.status)
          ) {
            row.status = patch.status;
            return Promise.resolve({ affected: 1 });
          }
          return Promise.resolve({ affected: 0 });
        },
      ),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        {
          provide: getRepositoryToken(DeletionRequest),
          useValue: deletionRequests,
        },
        { provide: getRepositoryToken(DsarRequest), useValue: dsarRequests },
        { provide: getRepositoryToken(DataExportJob), useValue: exportJobs },
        {
          provide: getRepositoryToken(EmailPreference),
          useValue: emailPreferences,
        },
        {
          provide: getRepositoryToken(AccountReauthToken),
          useValue: reauthTokens,
        },
        {
          provide: getRepositoryToken(AccountDeactivation),
          useValue: deactivations,
        },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        { provide: AccountExportService, useValue: exportService },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = module.get(AccountService);
  });

  describe('reauth', () => {
    it('mints a token and records its expiry timestamp', async () => {
      const result = await service.reauth('u1');

      expect(result.reauthToken).toEqual(expect.any(String));
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(reauthTokens.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          token: result.reauthToken,
          expiresAt: expect.any(Date),
        }),
      );
    });
  });

  describe('deletion-request lifecycle', () => {
    it('requestDeletion rejects without a valid reauth token', async () => {
      reauthTokens.findOne.mockResolvedValue(null);
      await expect(
        service.requestDeletion('u1', { reauthToken: 'bogus' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(deletionRequests.save).not.toHaveBeenCalled();
    });

    it('requestDeletion schedules a 30-day grace period and returns the FE shape', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.requestDeletion('u1', {
        reauthToken: 'tok',
        reason: 'moving on',
      });

      expect(result.id).toBe('del-1');
      expect(result.status).toBe('grace');
      expect(result.gracePeriodDays).toBe(30);
      expect(result.requestedAt).toBe(now.toISOString());
      expect(new Date(result.scheduledErasureAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1' }),
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
    });

    it('requestDeletion conflicts when one is already scheduled', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });
      deletionRequests.findOne.mockResolvedValue({
        id: 'del-1',
        userId: 'u1',
        status: DeletionRequestStatus.Grace,
      });

      await expect(
        service.requestDeletion('u1', { reauthToken: 'tok' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('getDeletionRequest returns null when none is pending', async () => {
      deletionRequests.findOne.mockResolvedValue(null);
      await expect(service.getDeletionRequest('u1')).resolves.toBeNull();
    });

    it('getDeletionRequest surfaces the active request in the FE shape', async () => {
      deletionRequests.findOne.mockResolvedValue({
        id: 'del-1',
        userId: 'u1',
        status: DeletionRequestStatus.Grace,
        scheduledFor: new Date('2026-08-14T12:00:00.000Z'),
        createdAt: now,
      });

      const result = await service.getDeletionRequest('u1');
      expect(result).toEqual({
        id: 'del-1',
        status: 'grace',
        requestedAt: now.toISOString(),
        scheduledErasureAt: '2026-08-14T12:00:00.000Z',
        gracePeriodDays: 30,
      });
    });

    it('cancelDeletionRequest 404s when there is nothing to cancel', async () => {
      deletionRequests.findOne.mockResolvedValue(null);
      await expect(service.cancelDeletionRequest('u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cancelDeletionRequest flips status to cancelled', async () => {
      const row = {
        id: 'del-1',
        userId: 'u1',
        status: DeletionRequestStatus.Grace,
        previousStatus: UserStatus.Active,
      };
      deletionRequests.findOne.mockResolvedValue(row);
      users.u1.status = UserStatus.Deactivated;

      await service.cancelDeletionRequest('u1');

      expect(deletionRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: DeletionRequestStatus.Cancelled }),
      );
    });

    it('requestDeletion hides the member by setting status Deactivated', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });
      deletionRequests.findOne.mockResolvedValue(null);
      deactivations.findOne.mockResolvedValue(null);

      await service.requestDeletion('u1', { reauthToken: 'tok' });

      // The whole point: "everything is hidden now" is now true.
      expect(users.u1.status).toBe(UserStatus.Deactivated);
      expect(deletionRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({ previousStatus: UserStatus.Active }),
      );
    });

    it('cancelDeletionRequest restores the recorded status, not a hardcoded Active', async () => {
      // 🔴 A suspended member must not launder their suspension by opening a
      // deletion request and immediately cancelling it.
      deletionRequests.findOne.mockResolvedValue({
        id: 'del-1',
        userId: 'u1',
        status: DeletionRequestStatus.Grace,
        previousStatus: UserStatus.Suspended,
      });
      deactivations.findOne.mockResolvedValue(null);
      users.u1.status = UserStatus.Deactivated;

      await service.cancelDeletionRequest('u1');

      expect(users.u1.status).toBe(UserStatus.Suspended);
    });

    it('cancelDeletionRequest leaves a separately-deactivated member hidden', async () => {
      deletionRequests.findOne.mockResolvedValue({
        id: 'del-1',
        userId: 'u1',
        status: DeletionRequestStatus.Grace,
        previousStatus: UserStatus.Active,
      });
      // They paused their account first, then asked to be erased. Cancelling
      // the erasure cancels only the erasure.
      deactivations.findOne.mockResolvedValue({
        id: 'deact-1',
        userId: 'u1',
        reactivatedAt: null,
        previousStatus: UserStatus.Active,
      });
      users.u1.status = UserStatus.Deactivated;

      await service.cancelDeletionRequest('u1');

      expect(users.u1.status).toBe(UserStatus.Deactivated);
    });
  });

  describe('deactivate', () => {
    it('rejects without a valid reauth token', async () => {
      await expect(
        service.deactivate('u1', { reauthToken: 'bogus' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('persists a deactivation row and revokes sessions', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.deactivate('u1', { reauthToken: 'tok' });

      expect(result).toEqual({ status: 'deactivated' });
      expect(deactivations.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1' }),
      );
      expect(refreshTokens.update).toHaveBeenCalled();
      // The row alone hid nobody before — the status change is what does it.
      expect(users.u1.status).toBe(UserStatus.Deactivated);
      // Revoking refresh tokens does NOT close a live socket: the access token
      // still carries `status: 'active'` for up to its 15m TTL, and the chat
      // gateway reads status off the claims without hitting the DB. Without
      // this event the member stays online, and visible in presence, while
      // every HTTP route already rejects them.
      expect(events.emit).toHaveBeenCalledWith('user.session.revoked', {
        userId: 'u1',
      });
    });

    it('records the prior status so reactivation can restore it', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });
      // 🔴 A suspended member is allowed to deactivate — deactivation is
      // strictly more restrictive than suspension, so it grants them nothing.
      // What must not happen is coming back as Active.
      users.u1.status = UserStatus.Suspended;

      await service.deactivate('u1', { reauthToken: 'tok' });

      expect(deactivations.save).toHaveBeenCalledWith(
        expect.objectContaining({ previousStatus: UserStatus.Suspended }),
      );
      expect(users.u1.status).toBe(UserStatus.Deactivated);
    });

    it('never records Deactivated as the status to restore to', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });
      // Already deactivated (a repeat call). Reading `users.status` naively
      // here would overwrite the real prior status with `deactivated` and
      // strand the member.
      users.u1.status = UserStatus.Deactivated;
      deactivations.findOne.mockResolvedValue({
        id: 'deact-1',
        userId: 'u1',
        reactivatedAt: null,
        previousStatus: UserStatus.Suspended,
      });

      await service.deactivate('u1', { reauthToken: 'tok' });

      expect(deactivations.save).toHaveBeenCalledWith(
        expect.objectContaining({ previousStatus: UserStatus.Suspended }),
      );
    });
  });

  describe('export', () => {
    it('requestExport creates an already-ready job and returns the envelope with requestedAt', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.requestExport('u1', {
        categories: ['profile'],
        format: 'json',
        reauthToken: 'tok',
      });
      expect(result.status).toBe('ready');
      expect(result.jobId).toBe('job-1');
      // M1: POST /account/export must include requestedAt.
      expect(result.requestedAt).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(result.requestedAt))).toBe(false);
      // I3: a ready job exposes a download link.
      expect(result.downloadUrl).toBe('/account/export/job-1/download');
      expect(exportJobs.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', status: 'ready' }),
      );
    });

    it('requestExport rejects a missing or stale step-up token and builds nothing', async () => {
      // No matching row — a bogus or already-consumed token.
      reauthTokens.findOne.mockResolvedValue(null);
      await expect(
        service.requestExport('u1', {
          categories: ['profile'],
          format: 'json',
          reauthToken: 'bogus',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // An expired token is equally refused.
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() - 1_000),
      });
      await expect(
        service.requestExport('u1', {
          categories: ['profile'],
          format: 'json',
          reauthToken: 'tok',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // The archive must never be assembled for an unauthenticated caller.
      expect(exportJobs.save).not.toHaveBeenCalled();
    });

    it('getExportJob 404s for an unknown/foreign job', async () => {
      exportJobs.findOne.mockResolvedValue(null);
      await expect(service.getExportJob('u1', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('getExportJob returns the ExportJob envelope; download gated on ready', async () => {
      exportJobs.findOne.mockResolvedValue({
        id: 'job-1',
        userId: 'u1',
        status: 'ready',
        generatedAt: now,
        requestedAt: now,
        data: { manifest: {} },
        error: null,
      });
      const result = await service.getExportJob('u1', 'job-1');
      expect(result.jobId).toBe('job-1');
      expect(result.status).toBe('ready');
      expect(result.requestedAt).toBe(now.toISOString());
      expect(result.downloadUrl).toBe('/account/export/job-1/download');
      expect(result.expiresAt).toEqual(expect.any(String));
    });

    it('getExportJob omits downloadUrl while the job is still processing', async () => {
      exportJobs.findOne.mockResolvedValue({
        id: 'job-2',
        userId: 'u1',
        status: 'processing',
        generatedAt: null,
        requestedAt: now,
        data: null,
        error: null,
      });
      const result = await service.getExportJob('u1', 'job-2');
      expect(result.status).toBe('processing');
      expect(result.downloadUrl).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe('dsar', () => {
    it('submitDsar rejects without a valid reauth token', async () => {
      await expect(
        service.submitDsar('u1', {
          article: 15,
          scopes: ['profile'],
          details: 'give me my data',
          reauthToken: 'bogus',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('submitDsar creates a reference + 30-day due date', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.submitDsar('u1', {
        article: 17,
        scopes: ['profile', 'messages'],
        details: 'erase me',
        reauthToken: 'tok',
      });

      expect(result.reference).toMatch(/^DSAR-/);
      expect(result.article).toBe(17);
      expect(result.status).toBe('received');
      const dueBy = new Date(result.dueBy).getTime();
      const submittedAt = new Date(result.submittedAt).getTime();
      expect(dueBy - submittedAt).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('listDsar returns the caller history', async () => {
      dsarRequests.find.mockResolvedValue([
        {
          reference: 'DSAR-ABC',
          article: 15,
          status: 'received',
          submittedAt: now,
          dueBy: now,
          respondedAt: null,
        },
      ]);
      const result = await service.listDsar('u1');
      expect(result).toHaveLength(1);
      expect(result[0].reference).toBe('DSAR-ABC');
    });
  });

  describe('sessions (backed by the refresh-token store)', () => {
    it('listSessions flags the presenting session as current, others as not', async () => {
      // The presenting refresh_token cookie hashes to rt-current's row.
      refreshTokens.findOne.mockResolvedValue({ id: 'rt-current' });
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-current',
          userId: 'u1',
          userAgent: 'Chrome',
          createdAt: now,
          expiresAt: now,
          revokedAt: null,
        },
        {
          id: 'rt-other',
          userId: 'u1',
          userAgent: 'Firefox',
          createdAt: now,
          expiresAt: now,
          revokedAt: null,
        },
      ]);
      const result = await service.listSessions('u1', 'raw-refresh');
      expect(result).toEqual([
        {
          id: 'rt-current',
          deviceLabel: null,
          userAgent: 'Chrome',
          current: true,
          createdAt: now.toISOString(),
          expiresAt: now.toISOString(),
        },
        {
          id: 'rt-other',
          deviceLabel: null,
          userAgent: 'Firefox',
          current: false,
          createdAt: now.toISOString(),
          expiresAt: now.toISOString(),
        },
      ]);
    });

    it('listSessions marks nothing current when no refresh cookie is presented', async () => {
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-1',
          userId: 'u1',
          userAgent: 'Chrome',
          createdAt: now,
          expiresAt: now,
          revokedAt: null,
        },
      ]);
      const result = await service.listSessions('u1');
      expect(refreshTokens.findOne).not.toHaveBeenCalled();
      expect(result[0].current).toBe(false);
    });

    it('revokeSession 404s for an unknown/foreign/already-revoked session', async () => {
      refreshTokens.findOne.mockResolvedValue(null);
      await expect(service.revokeSession('u1', 'rt-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('revokeSession sets revokedAt on the matching refresh-token row', async () => {
      const row = {
        id: 'rt-1',
        userId: 'u1',
        revokedAt: null,
      };
      refreshTokens.findOne.mockResolvedValue(row);

      await service.revokeSession('u1', 'rt-1');

      expect(refreshTokens.findOne).toHaveBeenCalledWith({
        where: { id: 'rt-1', userId: 'u1' },
      });
      expect(refreshTokens.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rt-1', revokedAt: expect.any(Date) }),
      );
    });

    it('revokeOtherSessions revokes every live session EXCEPT the presenting one', async () => {
      // The cookie resolves to rt-current.
      refreshTokens.findOne.mockResolvedValue({ id: 'rt-current' });
      refreshTokens.find.mockResolvedValue([
        { id: 'rt-current', userId: 'u1', revokedAt: null },
        { id: 'rt-other-1', userId: 'u1', revokedAt: null },
        { id: 'rt-other-2', userId: 'u1', revokedAt: null },
      ]);

      await service.revokeOtherSessions('u1', 'raw-refresh');

      // Exactly the two non-current rows are saved with a revokedAt stamp; the
      // current session is left intact so the caller stays signed in here.
      expect(refreshTokens.save).toHaveBeenCalledTimes(1);
      const saved = refreshTokens.save.mock.calls[0][0] as Array<{
        id: string;
        revokedAt: Date;
      }>;
      expect(saved.map((r) => r.id).sort()).toEqual([
        'rt-other-1',
        'rt-other-2',
      ]);
      for (const r of saved) {
        expect(r.revokedAt).toEqual(expect.any(Date));
      }
    });

    it('revokeOtherSessions with no live others is a no-op', async () => {
      refreshTokens.findOne.mockResolvedValue({ id: 'rt-current' });
      refreshTokens.find.mockResolvedValue([
        { id: 'rt-current', userId: 'u1', revokedAt: null },
      ]);

      await service.revokeOtherSessions('u1', 'raw-refresh');
      expect(refreshTokens.save).not.toHaveBeenCalled();
    });

    it('revokeAllSessions updates every live token for the user (used by deactivate/deletion)', async () => {
      await service.revokeAllSessions('u1');
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1' }),
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
    });
  });

  describe('email preferences', () => {
    it('getEmailPreferences returns an EmailPreference[] of the default matrix', async () => {
      emailPreferences.find.mockResolvedValue([]);
      const result = await service.getEmailPreferences('u1');
      // One entry per default category, each { category, email }.
      expect(result).toHaveLength(
        Object.keys(DEFAULT_EMAIL_PREFERENCES).length,
      );
      const productUpdates = result.find(
        (p) => p.category === 'productUpdates',
      );
      expect(productUpdates).toEqual({
        category: 'productUpdates',
        email: true,
      });
    });

    it('getEmailPreferences layers stored overrides on top of the defaults', async () => {
      emailPreferences.find.mockResolvedValue([
        { category: 'productUpdates', enabled: false },
      ]);
      const result = await service.getEmailPreferences('u1');
      expect(result.find((p) => p.category === 'productUpdates')?.email).toBe(
        false,
      );
      expect(result.find((p) => p.category === 'communityDigest')?.email).toBe(
        true,
      );
    });

    it('getEmailPreferences marks ALWAYS_ON categories locked and always on', async () => {
      emailPreferences.find.mockResolvedValue([
        // Even a stored "off" override cannot turn a locked category off.
        { category: 'securityAlerts', enabled: false },
      ]);
      const result = await service.getEmailPreferences('u1');
      const security = result.find((p) => p.category === 'securityAlerts');
      expect(security).toEqual({
        category: 'securityAlerts',
        email: true,
        locked: true,
      });
    });

    it('updateEmailPreference upserts a single {category,email} toggle and returns the array', async () => {
      emailPreferences.findOne.mockResolvedValueOnce(null);
      emailPreferences.find.mockResolvedValue([
        { category: 'productUpdates', enabled: false },
      ]);

      const result = await service.updateEmailPreference('u1', {
        category: 'productUpdates',
        email: false,
      });

      expect(emailPreferences.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          category: 'productUpdates',
          enabled: false,
        }),
      );
      expect(result.find((p) => p.category === 'productUpdates')?.email).toBe(
        false,
      );
      // Untouched default survives.
      expect(result.find((p) => p.category === 'communityDigest')?.email).toBe(
        true,
      );
    });

    it('updateEmailPreference refuses to persist an ALWAYS_ON category toggle', async () => {
      const result = await service.updateEmailPreference('u1', {
        category: 'securityAlerts',
        email: false,
      });
      expect(emailPreferences.save).not.toHaveBeenCalled();
      expect(result.find((p) => p.category === 'securityAlerts')?.email).toBe(
        true,
      );
    });

    it('round-trips: an update is reflected on the next get', async () => {
      let stored: Array<{ category: string; enabled: boolean }> = [];
      emailPreferences.findOne.mockImplementation(
        ({ where }: { where: { category: string } }) =>
          Promise.resolve(
            stored.find((r) => r.category === where.category) ?? null,
          ),
      );
      emailPreferences.save.mockImplementation(
        (v: { category: string; enabled: boolean }) => {
          stored = stored.filter((r) => r.category !== v.category);
          stored.push(v);
          return Promise.resolve(v);
        },
      );
      emailPreferences.find.mockImplementation(() => Promise.resolve(stored));

      await service.updateEmailPreference('u1', {
        category: 'eventReminders',
        email: false,
      });
      const after = await service.getEmailPreferences('u1');

      expect(after.find((p) => p.category === 'eventReminders')?.email).toBe(
        false,
      );
    });
  });
});
