import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AccountExportService } from './account-export.service';
import { AccountService } from './account.service';
import { DAY_MS, EXPORT_LINK_EXPIRY_DAYS } from './account.constants';
import { AccountDeactivation } from './entities/account-deactivation.entity';
import { AccountReauthToken } from './entities/account-reauth-token.entity';
import {
  DataExportFormat,
  DataExportJob,
} from './entities/data-export-job.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from './entities/deletion-request.entity';
import { DsarRequest } from './entities/dsar-request.entity';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('AccountService', () => {
  let service: AccountService;
  let deletionRequests: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let dsarRequests: { find: jest.Mock; save: jest.Mock };
  let exportJobs: { findOne: jest.Mock; save: jest.Mock };
  let reauthTokens: {
    save: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
  };
  let deactivations: { findOne: jest.Mock; save: jest.Mock };
  let exportService: { build: jest.Mock; knownCategories: jest.Mock };
  let refreshTokens: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  // Stand-in for the `users` row the deactivation/deletion transactions read
  // and update. Tests set `users.u1.status` to drive the status a flow must
  // preserve, then assert on it after the call.
  let users: {
    u1: { id: string; status: UserStatus; role?: UserRole };
  } & Record<string, { id: string; status: UserStatus; role?: UserRole }>;
  // The sole-admin guard counts admins through `UsersService.countAdmins`,
  // inside the caller's transaction. Two by default, so the ordinary
  // deactivate/delete flows are never the last-admin case; the guard's own
  // test drops the count to one.
  let usersService: { countAdmins: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let events: { emit: jest.Mock };

  const now = new Date('2026-07-15T12:00:00.000Z');

  beforeEach(async () => {
    deletionRequests = {
      // `cancelDeletionRequest` cancels EVERY open grace row, so it reads the
      // set (not one row) and writes through a conditional `update`.
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
    reauthTokens = {
      save: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      // Single-use consume of a reauth token; wins the claim by default.
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
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
      // Range-check source for `requestExport` — the real service derives this
      // from its core contributions plus the registered contributors.
      knownCategories: jest
        .fn()
        .mockReturnValue([
          'profile',
          'messages',
          'forumPosts',
          'events',
          'connections',
          'activityLog',
        ]),
    };
    refreshTokens = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v: Partial<RefreshToken>) => Promise.resolve(v)),
      // UpdateResult-shaped: `revokeSession` reads `affected` to tell "revoked
      // this session" from "no such live session" (its 404).
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    users = { u1: { id: 'u1', status: UserStatus.Active } };
    usersService = { countAdmins: jest.fn().mockResolvedValue(2) };

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
      find: jest.fn((entity: unknown, options: unknown): Promise<unknown> => {
        if (entity === DeletionRequest) {
          return deletionRequests.find(options) as Promise<unknown>;
        }
        throw new Error('unexpected entity in manager.find');
      }),
      findOne: jest.fn(
        (
          entity: unknown,
          options: { where: Where | Where[] },
        ): Promise<unknown> => {
          const where = (
            Array.isArray(options.where) ? options.where[0] : options.where
          ) as Where;
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
          if (entity === DeletionRequest) {
            return deletionRequests.update(criteria, patch) as Promise<unknown>;
          }
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
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    service = module.get(AccountService);
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
        expect.objectContaining({ revokedAt: expect.any(Date) as unknown }),
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
      deletionRequests.find.mockResolvedValue([]);
      deletionRequests.findOne.mockResolvedValue(null);
      await expect(service.cancelDeletionRequest('u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cancelDeletionRequest cancels EVERY open grace row, not just one', async () => {
      // The data-loss shape this guards: a member who double-submitted holds
      // two grace rows, and a survivor would still be erased 30 days later.
      deletionRequests.find.mockResolvedValue([
        {
          id: 'del-1',
          userId: 'u1',
          status: DeletionRequestStatus.Grace,
          previousStatus: UserStatus.Active,
        },
        {
          id: 'del-2',
          userId: 'u1',
          status: DeletionRequestStatus.Grace,
          previousStatus: UserStatus.Active,
        },
      ]);
      deletionRequests.findOne.mockResolvedValue(null);
      users.u1.status = UserStatus.Deactivated;

      await service.cancelDeletionRequest('u1');

      // One set-based conditional update, addressed by (userId, status) —
      // never by the id of whichever row `findOne` happened to return.
      expect(deletionRequests.update).toHaveBeenCalledWith(
        { userId: 'u1', status: DeletionRequestStatus.Grace },
        { status: DeletionRequestStatus.Cancelled },
      );
    });

    it('cancelDeletionRequest refuses once the erasure sweep has claimed it', async () => {
      deletionRequests.find.mockResolvedValue([]);
      deletionRequests.findOne.mockResolvedValue({
        id: 'del-1',
        userId: 'u1',
        status: DeletionRequestStatus.Processing,
      });

      await expect(service.cancelDeletionRequest('u1')).rejects.toBeInstanceOf(
        ConflictException,
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
      deletionRequests.find.mockResolvedValue([
        {
          id: 'del-1',
          userId: 'u1',
          status: DeletionRequestStatus.Grace,
          previousStatus: UserStatus.Suspended,
        },
      ]);
      deletionRequests.findOne.mockResolvedValue(null);
      deactivations.findOne.mockResolvedValue(null);
      users.u1.status = UserStatus.Deactivated;

      await service.cancelDeletionRequest('u1');

      expect(users.u1.status).toBe(UserStatus.Suspended);
    });

    it('cancelDeletionRequest leaves a separately-deactivated member hidden', async () => {
      deletionRequests.find.mockResolvedValue([
        {
          id: 'del-1',
          userId: 'u1',
          status: DeletionRequestStatus.Grace,
          previousStatus: UserStatus.Active,
        },
      ]);
      deletionRequests.findOne.mockResolvedValue(null);
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

  // Step-up reauth is single-use and hashed-at-rest (finding L1). Exercised
  // through `deactivate` since `assertReauth` is private.
  describe('step-up reauth token (single-use, hashed)', () => {
    const liveReauthRow = () => ({
      id: 'reauth-1',
      userId: 'u1',
      token: sha256('tok'),
      expiresAt: new Date(Date.now() + 60_000),
    });

    it('looks the row up by the HASH of the presented token', async () => {
      reauthTokens.findOne.mockResolvedValue(liveReauthRow());

      await service.deactivate('u1', { reauthToken: 'tok' });

      expect(reauthTokens.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1', token: sha256('tok') },
      });
    });

    it('consumes the token on first successful use (single-use)', async () => {
      reauthTokens.findOne.mockResolvedValue(liveReauthRow());

      await service.deactivate('u1', { reauthToken: 'tok' });

      // The row is deleted, so the same token cannot authorize a second
      // destructive action within its TTL.
      expect(reauthTokens.delete).toHaveBeenCalledWith({ id: 'reauth-1' });
    });

    it('rejects when the token was already consumed by a concurrent action', async () => {
      reauthTokens.findOne.mockResolvedValue(liveReauthRow());
      // Lost the delete race: another request consumed the row first.
      reauthTokens.delete.mockResolvedValue({ affected: 0 });

      await expect(
        service.deactivate('u1', { reauthToken: 'tok' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
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

    // The sole-admin guard: an admin who deactivates (or erases) the last
    // admin account leaves the platform with nobody able to reverse it, and
    // the count is read inside the write's own transaction so a concurrent
    // action against a different admin cannot slip past a stale one.
    it('refuses to deactivate the last remaining admin', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });
      users.u1.role = UserRole.Admin;
      usersService.countAdmins.mockResolvedValue(1);

      await expect(
        service.deactivate('u1', { reauthToken: 'tok' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(deactivations.save).not.toHaveBeenCalled();
      expect(users.u1.status).toBe(UserStatus.Active);
    });

    it('lets an admin deactivate while another admin remains', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });
      users.u1.role = UserRole.Admin;
      usersService.countAdmins.mockResolvedValue(2);

      await expect(
        service.deactivate('u1', { reauthToken: 'tok' }),
      ).resolves.toEqual({ status: 'deactivated' });
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

    it('requestExport rejects a category the builder does not know', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.requestExport('u1', {
          categories: ['profile', 'not-a-category'],
          format: 'json',
          reauthToken: 'tok',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Nothing arbitrary is persisted on the job row.
      expect(exportJobs.save).not.toHaveBeenCalled();
    });

    it('requestExport reuses a ready job instead of rebuilding an identical archive', async () => {
      reauthTokens.findOne.mockResolvedValue({
        userId: 'u1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 60_000),
      });
      exportJobs.findOne.mockResolvedValue({
        id: 'job-earlier',
        userId: 'u1',
        status: 'ready',
        categories: ['profile'],
        format: DataExportFormat.Json,
        requestedAt: new Date(),
        generatedAt: new Date(),
        data: { manifest: {} },
      });

      const result = await service.requestExport('u1', {
        categories: ['profile'],
        format: 'json',
        reauthToken: 'tok',
      });

      expect(result.jobId).toBe('job-earlier');
      // No second full copy of the member's data.
      expect(exportService.build).not.toHaveBeenCalled();
      expect(exportJobs.save).not.toHaveBeenCalled();
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

    describe('getExportDownload', () => {
      // `generatedAt` is CLOCK-RELATIVE, and has to be: the download route now
      // enforces the advertised `EXPORT_LINK_EXPIRY_DAYS` window against the
      // real `Date.now()` (this suite does not fake timers, see the
      // `Date.now() + 60_000` reauth fixtures throughout). The old fixture
      // pinned `generatedAt` to the fixed `now` constant, which drifts further
      // into the past on every real-world day and would eventually have every
      // one of these tests failing on expiry rather than on what it asserts.
      const generatedAt = () => new Date(Date.now() - 60_000);

      const readyJob = (format: DataExportFormat) => ({
        id: 'job-1',
        userId: 'u1',
        status: 'ready',
        format,
        categories: ['profile'],
        generatedAt: generatedAt(),
        requestedAt: generatedAt(),
        data: { manifest: { schemaVersion: '1.0' }, profile: { email: 'a@b' } },
        error: null,
      });

      /** A ready job whose archive was generated `ageMs` ago. */
      const jobGeneratedAgo = (ageMs: number) => ({
        ...readyJob(DataExportFormat.Json),
        generatedAt: new Date(Date.now() - ageMs),
      });

      it('scopes the lookup to the owning user', async () => {
        // A job id is a uuid, but it is not a capability.
        exportJobs.findOne.mockResolvedValue(readyJob(DataExportFormat.Json));
        await service.getExportDownload('u1', 'job-1');
        expect(exportJobs.findOne).toHaveBeenCalledWith({
          where: { id: 'job-1', userId: 'u1' },
        });
      });

      it('404s for an unknown or foreign job', async () => {
        exportJobs.findOne.mockResolvedValue(null);
        await expect(
          service.getExportDownload('u1', 'nope'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('404s while the job is not ready, and when the payload is missing', async () => {
        exportJobs.findOne.mockResolvedValue({
          ...readyJob(DataExportFormat.Json),
          status: 'processing',
        });
        await expect(
          service.getExportDownload('u1', 'job-1'),
        ).rejects.toBeInstanceOf(NotFoundException);

        exportJobs.findOne.mockResolvedValue({
          ...readyJob(DataExportFormat.Json),
          data: null,
        });
        await expect(
          service.getExportDownload('u1', 'job-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it("serves a single .json for format 'json'", async () => {
        exportJobs.findOne.mockResolvedValue(readyJob(DataExportFormat.Json));
        const result = await service.getExportDownload('u1', 'job-1');
        expect(result.kind).toBe('json');
        expect(result.filename).toBe('queerpulse-export-job-1.json');
        expect(result.contentType).toBe('application/json');
      });

      it("serves a .zip for formats 'csv' and 'both'", async () => {
        for (const format of [DataExportFormat.Csv, DataExportFormat.Both]) {
          exportJobs.findOne.mockResolvedValue(readyJob(format));
          const result = await service.getExportDownload('u1', 'job-1');
          expect(result.kind).toBe('zip');
          expect(result.filename).toBe('queerpulse-export-job-1.zip');
          expect(result.contentType).toBe('application/zip');
        }
      });

      it('stores nothing extra — the zip is derived at download time', async () => {
        // The payload stays inline `jsonb`; no archive is persisted, so the
        // size ceiling documented on `AccountExportService.build` is unchanged.
        exportJobs.findOne.mockResolvedValue(readyJob(DataExportFormat.Both));
        await service.getExportDownload('u1', 'job-1');
        expect(exportJobs.save).not.toHaveBeenCalled();
      });

      describe('download-link expiry (EXPORT_LINK_EXPIRY_DAYS)', () => {
        // The API advertised `expiresAt` and enforced nothing, so a link the
        // member was told lasts 7 days kept serving until the 30-day retention
        // sweep nulled the payload. These pin the promise to the behaviour.

        it('serves an archive inside the window', async () => {
          exportJobs.findOne.mockResolvedValue(
            jobGeneratedAgo(EXPORT_LINK_EXPIRY_DAYS * DAY_MS - 60_000),
          );
          const result = await service.getExportDownload('u1', 'job-1');
          expect(result.kind).toBe('json');
        });

        it('refuses an archive past the window', async () => {
          exportJobs.findOne.mockResolvedValue(
            jobGeneratedAgo(EXPORT_LINK_EXPIRY_DAYS * DAY_MS + 60_000),
          );
          await expect(
            service.getExportDownload('u1', 'job-1'),
          ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('refuses exactly AT the boundary, and serves one millisecond before it', async () => {
          // The check is `expiresAt <= now`, so the expiry instant itself is
          // already too late. Both sides are pinned so a later refactor cannot
          // quietly move the comparison by a day.
          exportJobs.findOne.mockResolvedValue(
            jobGeneratedAgo(EXPORT_LINK_EXPIRY_DAYS * DAY_MS),
          );
          await expect(
            service.getExportDownload('u1', 'job-1'),
          ).rejects.toBeInstanceOf(NotFoundException);

          exportJobs.findOne.mockResolvedValue(
            jobGeneratedAgo(EXPORT_LINK_EXPIRY_DAYS * DAY_MS - 1),
          );
          await expect(
            service.getExportDownload('u1', 'job-1'),
          ).resolves.toMatchObject({ kind: 'json' });
        });

        it('does NOT wait for the 30-day retention sweep to destroy the payload', async () => {
          // The two windows are complementary. An archive between the link
          // expiry and the sweep still has its bytes in `data`, and must still
          // be refused: the sweeper is a cron that batches and can miss a tick,
          // so access cannot depend on it having run.
          const betweenTheTwoWindows = (EXPORT_LINK_EXPIRY_DAYS + 1) * DAY_MS;
          const job = jobGeneratedAgo(betweenTheTwoWindows);
          expect(job.data).not.toBeNull();
          exportJobs.findOne.mockResolvedValue(job);
          await expect(
            service.getExportDownload('u1', 'job-1'),
          ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('tells the owner the link expired rather than pretending it never existed', async () => {
          // Safe to differentiate: the `{ id, userId }` lookup already proved
          // ownership, so this only ever reaches the member whose export it is.
          exportJobs.findOne.mockResolvedValue(
            jobGeneratedAgo(EXPORT_LINK_EXPIRY_DAYS * DAY_MS + 60_000),
          );
          await expect(
            service.getExportDownload('u1', 'job-1'),
          ).rejects.toThrow(/expired/i);
        });

        it('leaves a job with no generatedAt to the not-ready guard', async () => {
          // No `generatedAt` means nothing was ever built, so there is no
          // window to be inside or outside of. It must still be refused, by the
          // guard above rather than by the expiry check.
          exportJobs.findOne.mockResolvedValue({
            ...readyJob(DataExportFormat.Json),
            generatedAt: null,
            data: null,
          });
          await expect(
            service.getExportDownload('u1', 'job-1'),
          ).rejects.toBeInstanceOf(NotFoundException);
        });
      });
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
      expect(result[0]?.reference).toBe('DSAR-ABC');
    });
  });

  describe('sessions (backed by the refresh-token store)', () => {
    // Every stored row now carries a session identity: `familyId` groups the
    // rows descended from one sign-in, `sessionStartedAt` is when that sign-in
    // happened. Fixtures spell both out because the mapping depends on them.
    const started = new Date('2026-08-01T10:00:00Z');

    it('listSessions flags the presenting session as current, others as not', async () => {
      // The presenting refresh_token cookie hashes to a row in fam-current.
      refreshTokens.findOne.mockResolvedValue({
        id: 'rt-current',
        familyId: 'fam-current',
      });
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-current',
          familyId: 'fam-current',
          userId: 'u1',
          userAgent: 'Chrome',
          sessionStartedAt: started,
          createdAt: now,
          expiresAt: now,
          revokedAt: null,
        },
        {
          id: 'rt-other',
          familyId: 'fam-other',
          userId: 'u1',
          userAgent: 'Firefox',
          sessionStartedAt: started,
          createdAt: now,
          expiresAt: now,
          revokedAt: null,
        },
      ]);
      const result = await service.listSessions('u1', 'raw-refresh');
      expect(result).toEqual([
        {
          // The FAMILY id, which is what the frontend revokes by.
          id: 'fam-current',
          deviceLabel: null,
          userAgent: 'Chrome',
          current: true,
          createdAt: started.toISOString(),
          lastUsedAt: now.toISOString(),
          expiresAt: now.toISOString(),
        },
        {
          id: 'fam-other',
          deviceLabel: null,
          userAgent: 'Firefox',
          current: false,
          createdAt: started.toISOString(),
          lastUsedAt: now.toISOString(),
          expiresAt: now.toISOString(),
        },
      ]);
    });

    it('listSessions collapses a family holding two live rows into one device', async () => {
      // A rotation race leaves the winner's row live alongside the replacement
      // (see AuthService.issueGraceReplacement). One browser, one entry.
      const newer = new Date('2026-08-20T12:00:00Z');
      const older = new Date('2026-08-20T11:00:00Z');
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-newer',
          familyId: 'fam-1',
          userId: 'u1',
          userAgent: 'Chrome',
          sessionStartedAt: started,
          createdAt: newer,
          expiresAt: now,
          revokedAt: null,
        },
        {
          id: 'rt-stranded',
          familyId: 'fam-1',
          userId: 'u1',
          userAgent: 'Chrome',
          sessionStartedAt: started,
          createdAt: older,
          expiresAt: now,
          revokedAt: null,
        },
      ]);

      const result = await service.listSessions('u1');

      expect(result).toHaveLength(1);
      // The newest row in the family supplies "last used".
      expect(result[0]?.lastUsedAt).toBe(newer.toISOString());
    });

    it('listSessions asks the store only for tokens that have not expired', async () => {
      // Expiry was never part of the filter, so a token that had simply run out
      // its 30-day life still showed under "active now" for the 30 further days
      // the purge job waits before deleting it.
      refreshTokens.find.mockResolvedValue([]);

      await service.listSessions('u1');

      const [options] = refreshTokens.find.mock.calls[0] as [
        { where: { expiresAt?: unknown } },
      ];
      expect(options.where.expiresAt).toBeDefined();
    });

    it('listSessions reports when the session SIGNED IN, not when it last rotated', async () => {
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-1',
          familyId: 'fam-1',
          userId: 'u1',
          userAgent: 'Chrome',
          sessionStartedAt: started,
          createdAt: now,
          expiresAt: now,
          revokedAt: null,
        },
      ]);

      const result = await service.listSessions('u1');

      expect(result[0]?.createdAt).toBe(started.toISOString());
    });

    it('listSessions marks nothing current when no refresh cookie is presented', async () => {
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-1',
          familyId: 'fam-1',
          userId: 'u1',
          userAgent: 'Chrome',
          sessionStartedAt: started,
          createdAt: now,
          expiresAt: now,
          revokedAt: null,
        },
      ]);
      const result = await service.listSessions('u1');
      expect(refreshTokens.findOne).not.toHaveBeenCalled();
      expect(result[0]?.current).toBe(false);
    });

    it('revokeSession 404s for an unknown/foreign/already-revoked session', async () => {
      refreshTokens.update.mockResolvedValue({ affected: 0 });
      await expect(service.revokeSession('u1', 'fam-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('revokeSession revokes every live row in the family, scoped to the caller', async () => {
      refreshTokens.update.mockResolvedValue({ affected: 2 });

      await service.revokeSession('u1', 'fam-1');

      // Scoped by userId so one member cannot end another member's session, and
      // by family so a sibling row stranded by a rotation race dies with it.
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ familyId: 'fam-1', userId: 'u1' }),
        expect.objectContaining({ revokedAt: expect.any(Date) as unknown }),
      );
    });

    // The revoked device keeps a valid access token for the rest of its TTL and
    // ChatGateway accepts it, so without this event "sign out this device" left
    // that device's socket receiving messages and presence for up to 15 minutes.
    it('revokeSession drops the member live sockets', async () => {
      refreshTokens.update.mockResolvedValue({ affected: 1 });

      await service.revokeSession('u1', 'fam-1');

      expect(events.emit).toHaveBeenCalledWith('user.session.revoked', {
        userId: 'u1',
      });
    });

    it('revokeOtherSessions revokes every live session EXCEPT the presenting one', async () => {
      // The cookie resolves to a row in fam-current.
      refreshTokens.findOne.mockResolvedValue({
        id: 'rt-current',
        familyId: 'fam-current',
      });
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-current',
          familyId: 'fam-current',
          userId: 'u1',
          revokedAt: null,
        },
        {
          id: 'rt-other-1',
          familyId: 'fam-other-1',
          userId: 'u1',
          revokedAt: null,
        },
        {
          id: 'rt-other-2',
          familyId: 'fam-other-2',
          userId: 'u1',
          revokedAt: null,
        },
      ]);

      await service.revokeOtherSessions('u1', 'raw-refresh');

      // Exactly the two non-current rows are saved with a revokedAt stamp; the
      // current session is left intact so the caller stays signed in here.
      expect(refreshTokens.save).toHaveBeenCalledTimes(1);
      const [saved] = refreshTokens.save.mock.calls[0] as [
        Array<{ id: string; revokedAt: Date }>,
      ];
      expect(saved.map((r) => r.id).sort()).toEqual([
        'rt-other-1',
        'rt-other-2',
      ]);
      for (const r of saved) {
        expect(r.revokedAt).toEqual(expect.any(Date));
      }
    });

    it('revokeOtherSessions keeps every row of the caller own session', async () => {
      // Two live rows, one family: the caller's browser after a rotation race.
      // Matching on the row id alone would have revoked the sibling and left
      // this device one rotation away from a spurious "session expired".
      refreshTokens.findOne.mockResolvedValue({
        id: 'rt-current',
        familyId: 'fam-current',
      });
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-current',
          familyId: 'fam-current',
          userId: 'u1',
          revokedAt: null,
        },
        {
          id: 'rt-sibling',
          familyId: 'fam-current',
          userId: 'u1',
          revokedAt: null,
        },
      ]);

      await service.revokeOtherSessions('u1', 'raw-refresh');

      expect(refreshTokens.save).not.toHaveBeenCalled();
    });

    it('revokeOtherSessions drops live sockets too', async () => {
      refreshTokens.findOne.mockResolvedValue({
        id: 'rt-current',
        familyId: 'fam-current',
      });
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-current',
          familyId: 'fam-current',
          userId: 'u1',
          revokedAt: null,
        },
        {
          id: 'rt-other-1',
          familyId: 'fam-other-1',
          userId: 'u1',
          revokedAt: null,
        },
      ]);

      await service.revokeOtherSessions('u1', 'raw-refresh');

      expect(events.emit).toHaveBeenCalledWith('user.session.revoked', {
        userId: 'u1',
      });
    });

    it('revokeOtherSessions with no live others is a no-op', async () => {
      refreshTokens.findOne.mockResolvedValue({
        id: 'rt-current',
        familyId: 'fam-current',
      });
      refreshTokens.find.mockResolvedValue([
        {
          id: 'rt-current',
          familyId: 'fam-current',
          userId: 'u1',
          revokedAt: null,
        },
      ]);

      await service.revokeOtherSessions('u1', 'raw-refresh');
      expect(refreshTokens.save).not.toHaveBeenCalled();
      // Nothing was revoked, so nothing should be disconnected either.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('revokeAllSessions updates every live token for the user (used by deactivate/deletion)', async () => {
      await service.revokeAllSessions('u1');
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1' }),
        expect.objectContaining({ revokedAt: expect.any(Date) as unknown }),
      );
    });
  });
});
