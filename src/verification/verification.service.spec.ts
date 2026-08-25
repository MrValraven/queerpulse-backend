import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { MemberVerification } from './entities/member-verification.entity';
import { VerificationEvent } from './entities/verification-event.entity';
import { VerificationRequest } from './entities/verification-request.entity';
import { IDENTITY_VERIFICATION_PROVIDER } from './providers/identity-verification.provider';
import { VerificationRequestStatus } from './verification-request-status';
import {
  VerificationEventAction,
  VerificationGrantedBy,
  VerificationLevel,
  VerificationType,
} from './verification-level';
import { VerificationService } from './verification.service';

describe('VerificationService', () => {
  let service: VerificationService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let eventRepo: {
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let requestRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  /** `bulkDecide`'s transactional `EntityManager` stand-in — the manager
   * `requestRepo.manager.transaction`'s stub hands to the callback.
   * `find`/`create` back the batched `MemberVerification` load+create
   * (approve only), `insert` backs the batched `VerificationEvent` write,
   * `save` backs both the batched member-row save and the batched
   * request-row save (see each test's assertions for which). */
  let manager: {
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
  };
  let profileRepo: { find: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let notifications: { create: jest.Mock };
  let configValues: Record<string, string | undefined>;

  /** Chainable `Repository.createQueryBuilder()` stand-in for
   * `computeSignals`'s grouped `duplicateProviderRef` query — every method
   * `.select()/.where()/.andWhere()` returns the same object so the real
   * fluent-builder call chain works, and `getRawMany` resolves to `rows`. */
  const fakeQueryBuilder = (rows: { userId: string }[] = []) => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  });

  /** A `users` row created well in the past — `computeSignals`'s
   * `accountAgeDays` reads its `createdAt`. */
  const fakeUser = (overrides: Partial<User> = {}): User =>
    ({
      id: userId,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }) as User;

  const userId = 'member-1';
  const actorId = 'admin-1';
  const requestId = 'request-1';

  /** A `member_verifications` row currently at `phone`, member-earned. */
  const currentPhoneRow = () => ({
    userId,
    level: VerificationLevel.Phone,
    method: 'phone_otp',
    provider: 'dev_phone',
    providerRef: null,
    verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'identity',
    grantedBy: VerificationGrantedBy.MemberEarned,
    reviewedByUserId: null,
  });

  /** A `verification_requests` row, pending by default. */
  const fakeRequest = (
    overrides: Partial<VerificationRequest> = {},
  ): VerificationRequest =>
    ({
      id: requestId,
      userId,
      type: VerificationType.Identity,
      requestedLevel: VerificationLevel.IdVerified,
      status: VerificationRequestStatus.Pending,
      context: null,
      evidenceRef: null,
      decisionReason: null,
      reviewedByUserId: null,
      signals: null,
      isAppeal: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }) as VerificationRequest;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      // Default: no duplicate rows. `computeSignals` only reaches this at
      // all when the member's own `providerRef` is non-null, so most tests
      // never exercise it — this default just keeps an accidental call from
      // throwing "not a function".
      createQueryBuilder: jest.fn().mockReturnValue(fakeQueryBuilder([])),
    };
    eventRepo = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    // `bulkDecide`'s transactional manager — mirrors `forum-posts.service
    // .spec.ts`'s `posts.manager.transaction` stub: runs the callback
    // synchronously against this same `manager` object so the batched
    // reads/writes inside `applyBulkDecision` are assertable.
    manager = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_entity: unknown, value: object) => ({ ...value })),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      insert: jest
        .fn()
        .mockResolvedValue({ identifiers: [], generatedMaps: [], raw: [] }),
    };
    requestRepo = {
      findOne: jest.fn(),
      // `bulkDecide`'s ONE batched load (`find({ where: { id: In(ids) } })`)
      // — distinct from `findOne`, which every OTHER request-lifecycle
      // method still uses. Defaults empty so a test that doesn't touch
      // `bulkDecide` never has to mock it.
      find: jest.fn().mockResolvedValue([]),
      // Real TypeORM assigns the uuid PK on `create`/`save`; the mock needs to
      // do the same so `submitRequest`'s "carries the new requestId" test can
      // assert against a real, defined id rather than `undefined`.
      create: jest.fn((value: object) => ({ id: 'new-request-id', ...value })),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      // `computeSignals`'s `priorRejections` count — 0 rejections by
      // default so the many tests that don't care about this signal never
      // have to mock it explicitly.
      count: jest.fn().mockResolvedValue(0),
      manager: {
        transaction: jest.fn(
          async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
        ),
      },
    };
    profileRepo = { find: jest.fn().mockResolvedValue([]) };
    // `computeSignals`'s `accountAgeDays` source. Defaults to a real user so
    // every existing `submitRequest`/`decideRequest` test (which never
    // asserts on `.signals`) exercises the real code path instead of the
    // `user === undefined` fallback.
    userRepo = { findOne: jest.fn().mockResolvedValue(fakeUser()) };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    // Default: automated elevation OFF (Phase 2 manual-first default).
    configValues = { VERIFICATION_AUTOMATED_ELEVATION: undefined };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationService,
        { provide: getRepositoryToken(MemberVerification), useValue: repo },
        {
          provide: getRepositoryToken(VerificationEvent),
          useValue: eventRepo,
        },
        {
          provide: getRepositoryToken(VerificationRequest),
          useValue: requestRepo,
        },
        { provide: getRepositoryToken(Profile), useValue: profileRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        {
          provide: IDENTITY_VERIFICATION_PROVIDER,
          useValue: {
            parseCallback: jest.fn((payload: { providerRef: string }) => ({
              providerRef: payload.providerRef,
              verified: true,
            })),
          },
        },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
      ],
    }).compile();

    service = module.get(VerificationService);
  });

  // --- Task 3: audit events + reviewer attribution + history ---

  describe('override', () => {
    it('records reviewer, marks admin_granted, and writes an overridden event when raising', async () => {
      repo.findOne.mockResolvedValue(currentPhoneRow());

      const saved = await service.override(
        userId,
        VerificationLevel.IdVerified,
        actorId,
      );

      expect(saved.reviewedByUserId).toBe(actorId);
      expect(saved.grantedBy).toBe(VerificationGrantedBy.AdminGranted);
      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Overridden,
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.IdVerified,
          actorUserId: actorId,
        }),
      );
    });

    it('writes an overridden event (not downgraded) when the level is held steady', async () => {
      repo.findOne.mockResolvedValue(currentPhoneRow());

      await service.override(userId, VerificationLevel.Phone, actorId);

      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Overridden,
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.Phone,
        }),
      );
    });

    it('writes a downgraded event and requires a reason when lowering', async () => {
      repo.findOne.mockResolvedValue(currentPhoneRow());

      await expect(
        service.override(userId, VerificationLevel.Email, actorId),
      ).rejects.toThrow(/reason/i);
      expect(eventRepo.save).not.toHaveBeenCalled();

      const saved = await service.override(
        userId,
        VerificationLevel.Email,
        actorId,
        'duplicate account',
      );

      expect(saved.level).toBe(VerificationLevel.Email);
      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Downgraded,
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.Email,
          reason: 'duplicate account',
        }),
      );
    });
  });

  describe('listHistory', () => {
    it('returns events newest-first for the member', async () => {
      const fakeEvents = [
        {
          id: 'event-2',
          userId,
          requestId: null,
          actorUserId: actorId,
          action: VerificationEventAction.Overridden,
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.IdVerified,
          reason: null,
          signals: null,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
        {
          id: 'event-1',
          userId,
          requestId: null,
          actorUserId: null,
          action: VerificationEventAction.Submitted,
          fromLevel: null,
          toLevel: VerificationLevel.Phone,
          reason: null,
          signals: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ];
      eventRepo.find.mockResolvedValue(fakeEvents);

      const history = await service.listHistory(userId);

      expect(eventRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
          order: { createdAt: 'DESC' },
        }),
      );
      expect(history).toEqual(fakeEvents);
    });
  });

  // --- Task 4: notify member on override/downgrade ---

  describe('override notifications', () => {
    it('notifies the member on override, carrying fromLevel/toLevel', async () => {
      repo.findOne.mockResolvedValue(currentPhoneRow());

      await service.override(userId, VerificationLevel.IdVerified, actorId);

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        userId,
        NotificationType.VerificationUpdate,
        expect.objectContaining({
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.IdVerified,
        }),
      );
    });

    it('notifies the member on a downgrade', async () => {
      repo.findOne.mockResolvedValue(currentPhoneRow());

      await service.override(
        userId,
        VerificationLevel.Email,
        actorId,
        'duplicate account',
      );

      expect(notifications.create).toHaveBeenCalledWith(
        userId,
        NotificationType.VerificationUpdate,
        expect.objectContaining({
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.Email,
        }),
      );
    });

    it('skips the notification on a no-op override (level unchanged)', async () => {
      repo.findOne.mockResolvedValue(currentPhoneRow());

      await service.override(userId, VerificationLevel.Phone, actorId);

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  // --- Phase 3 (Task 1): anti-fraud signals + duplicate detection ---

  describe('computeSignals', () => {
    it("computes accountAgeDays as a whole-day diff from the user's createdAt", async () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      userRepo.findOne.mockResolvedValue(fakeUser({ createdAt: tenDaysAgo }));
      repo.findOne.mockResolvedValue(null);

      const signals = await service.computeSignals(userId);

      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: userId },
      });
      expect(signals.accountAgeDays).toBe(10);
    });

    it('reads accountAgeDays as 0 when the user row is missing rather than throwing', async () => {
      userRepo.findOne.mockResolvedValue(null);
      repo.findOne.mockResolvedValue(null);

      const signals = await service.computeSignals(userId);

      expect(signals.accountAgeDays).toBe(0);
    });

    it("counts the member's prior rejected requests for the type", async () => {
      requestRepo.count.mockResolvedValue(3);
      repo.findOne.mockResolvedValue(null);

      const signals = await service.computeSignals(userId);

      expect(requestRepo.count).toHaveBeenCalledWith({
        where: {
          userId,
          type: VerificationType.Identity,
          status: VerificationRequestStatus.Rejected,
        },
      });
      expect(signals.priorRejections).toBe(3);
    });

    it('leaves duplicateProviderRef null when the member has no providerRef', async () => {
      repo.findOne.mockResolvedValue({
        userId,
        providerRef: null,
        type: VerificationType.Identity,
      });

      const signals = await service.computeSignals(userId);

      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
      expect(signals.duplicateProviderRef).toBeNull();
    });

    it('leaves duplicateProviderRef null when the providerRef is unique (no other rows)', async () => {
      repo.findOne.mockResolvedValue({
        userId,
        providerRef: 'unique-session-ref',
        type: VerificationType.Identity,
      });
      repo.createQueryBuilder.mockReturnValue(fakeQueryBuilder([]));

      const signals = await service.computeSignals(userId);

      expect(signals.duplicateProviderRef).toBeNull();
    });

    it('flags a providerRef shared by other accounts via ONE grouped query, never per-row', async () => {
      repo.findOne.mockResolvedValue({
        userId,
        providerRef: 'shared-session-ref',
        type: VerificationType.Identity,
      });
      const queryBuilder = fakeQueryBuilder([
        { userId: 'member-2' },
        { userId: 'member-3' },
      ]);
      repo.createQueryBuilder.mockReturnValue(queryBuilder);

      const signals = await service.computeSignals(userId);

      // ONE createQueryBuilder call, ONE getRawMany — not a lookup per
      // duplicate row.
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(queryBuilder.getRawMany).toHaveBeenCalledTimes(1);
      expect(signals.duplicateProviderRef).toEqual({
        count: 2,
        userIds: ['member-2', 'member-3'],
      });
    });
  });

  // --- Task 3: request lifecycle + state machine ---

  describe('submitRequest', () => {
    it('rejects (409) when an open request already exists for the member+type', async () => {
      requestRepo.findOne.mockResolvedValue(fakeRequest());

      await expect(
        service.submitRequest(userId, {
          requestedLevel: VerificationLevel.IdVerified,
        }),
      ).rejects.toThrow(/already open/i);
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it('creates a pending request and writes a Submitted event carrying the new requestId', async () => {
      requestRepo.findOne.mockResolvedValue(null);

      const created = await service.submitRequest(userId, {
        requestedLevel: VerificationLevel.IdVerified,
        context: 'here is why I need this',
      });

      expect(created.id).toBe('new-request-id');
      expect(created.status).toBe(VerificationRequestStatus.Pending);
      expect(created.requestedLevel).toBe(VerificationLevel.IdVerified);
      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Submitted,
          requestId: 'new-request-id',
          actorUserId: userId,
          toLevel: VerificationLevel.IdVerified,
        }),
      );
    });

    it('snapshots computeSignals onto the new request (Phase 3, Task 1)', async () => {
      requestRepo.findOne.mockResolvedValue(null);
      requestRepo.count.mockResolvedValue(1);
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      userRepo.findOne.mockResolvedValue(fakeUser({ createdAt: fiveDaysAgo }));
      repo.findOne.mockResolvedValue(null);

      const created = await service.submitRequest(userId, {
        requestedLevel: VerificationLevel.IdVerified,
      });

      expect(created.signals).toEqual({
        accountAgeDays: 5,
        priorRejections: 1,
        duplicateProviderRef: null,
      });
    });
  });

  describe('withdrawRequest', () => {
    it('withdraws an owned pending request', async () => {
      requestRepo.findOne.mockResolvedValue(fakeRequest());

      const saved = await service.withdrawRequest(userId, requestId);

      expect(saved.status).toBe(VerificationRequestStatus.Withdrawn);
      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Withdrawn,
          requestId,
          actorUserId: userId,
        }),
      );
    });

    it('409s when the request is not in a withdrawable state (e.g. rejected)', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({ status: VerificationRequestStatus.Rejected }),
      );

      await expect(service.withdrawRequest(userId, requestId)).rejects.toThrow(
        /cannot move/i,
      );
    });

    it('403s when the request belongs to someone else', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({ userId: 'someone-else' }),
      );

      await expect(service.withdrawRequest(userId, requestId)).rejects.toThrow(
        /do not own/i,
      );
    });

    it('404s when the request does not exist', async () => {
      requestRepo.findOne.mockResolvedValue(null);

      await expect(service.withdrawRequest(userId, requestId)).rejects.toThrow(
        /not found/i,
      );
    });
  });

  describe('appealRequest', () => {
    it('appeals a rejected request exactly once', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({ status: VerificationRequestStatus.Rejected }),
      );

      const saved = await service.appealRequest(userId, requestId);

      expect(saved.status).toBe(VerificationRequestStatus.Appealing);
      expect(saved.isAppeal).toBe(true);
      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Appealed,
          requestId,
          actorUserId: userId,
        }),
      );
    });

    it('409s on a second appeal of the same request', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({
          status: VerificationRequestStatus.Rejected,
          isAppeal: true,
        }),
      );

      await expect(service.appealRequest(userId, requestId)).rejects.toThrow(
        /already been appealed/i,
      );
    });

    it('409s when the request is not rejected', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({ status: VerificationRequestStatus.Pending }),
      );

      await expect(service.appealRequest(userId, requestId)).rejects.toThrow(
        /cannot move/i,
      );
    });
  });

  describe('decideRequest', () => {
    it('409s on an illegal transition (e.g. approving a withdrawn request)', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({ status: VerificationRequestStatus.Withdrawn }),
      );

      await expect(
        service.decideRequest(requestId, actorId, 'approve'),
      ).rejects.toThrow(/cannot move/i);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('400s rejecting without a reason', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({ status: VerificationRequestStatus.Pending }),
      );

      await expect(
        service.decideRequest(requestId, actorId, 'reject'),
      ).rejects.toThrow(/reason/i);
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it('approve raises the member level, writes exactly ONE Approved event (never Overridden), and notifies', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({
          status: VerificationRequestStatus.Pending,
          requestedLevel: VerificationLevel.IdVerified,
        }),
      );
      repo.findOne.mockResolvedValue(currentPhoneRow());

      const saved = await service.decideRequest(requestId, actorId, 'approve');

      expect(saved.status).toBe(VerificationRequestStatus.Approved);
      expect(saved.reviewedByUserId).toBe(actorId);

      expect(eventRepo.save).toHaveBeenCalledTimes(1);
      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Approved,
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.IdVerified,
          actorUserId: actorId,
          requestId,
        }),
      );
      // Never the override-style event for a request decision.
      expect(eventRepo.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: VerificationEventAction.Overridden }),
      );

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          level: VerificationLevel.IdVerified,
          grantedBy: VerificationGrantedBy.AdminGranted,
          reviewedByUserId: actorId,
        }),
      );

      expect(notifications.create).toHaveBeenCalledWith(
        userId,
        NotificationType.VerificationUpdate,
        expect.objectContaining({
          requestedLevel: VerificationLevel.IdVerified,
          decision: 'approved',
        }),
      );
    });

    it('approve still notifies the member when the requested level equals their current level (no-op raise)', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({
          status: VerificationRequestStatus.Pending,
          requestedLevel: VerificationLevel.Phone,
        }),
      );
      // Already at `phone` — grantLevel's own no-op-skip would stay silent.
      repo.findOne.mockResolvedValue(currentPhoneRow());

      await service.decideRequest(requestId, actorId, 'approve');

      // The event is still written regardless of the no-op raise.
      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Approved,
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.Phone,
        }),
      );

      // The member still hears about the decision even though their level
      // didn't move — a submitted request always gets an answer.
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        userId,
        NotificationType.VerificationUpdate,
        expect.objectContaining({
          requestedLevel: VerificationLevel.Phone,
          decision: 'approved',
        }),
      );
    });

    it('reject writes a Rejected event carrying the reason and notifies the member', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({ status: VerificationRequestStatus.Pending }),
      );

      const saved = await service.decideRequest(
        requestId,
        actorId,
        'reject',
        'needs a clearer document photo',
      );

      expect(saved.status).toBe(VerificationRequestStatus.Rejected);
      expect(saved.decisionReason).toBe('needs a clearer document photo');

      expect(eventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: VerificationEventAction.Rejected,
          requestId,
          actorUserId: actorId,
          reason: 'needs a clearer document photo',
        }),
      );

      expect(notifications.create).toHaveBeenCalledWith(
        userId,
        NotificationType.VerificationUpdate,
        expect.objectContaining({
          decision: 'rejected',
          reason: 'needs a clearer document photo',
        }),
      );

      // No level change on reject — the member-verification row is untouched.
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('in_review updates status only — no level event, no notification', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({ status: VerificationRequestStatus.Pending }),
      );

      const saved = await service.decideRequest(
        requestId,
        actorId,
        'in_review',
      );

      expect(saved.status).toBe(VerificationRequestStatus.InReview);
      expect(eventRepo.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('refreshes signals on every decision rather than reusing the submission-time snapshot (Phase 3, Task 1)', async () => {
      requestRepo.findOne.mockResolvedValue(
        fakeRequest({
          status: VerificationRequestStatus.Pending,
          // Stale snapshot from submission time — the decision should
          // overwrite this, not read it.
          signals: {
            accountAgeDays: 1,
            priorRejections: 0,
            duplicateProviderRef: null,
          },
        }),
      );
      requestRepo.count.mockResolvedValue(2);
      repo.findOne.mockResolvedValue(currentPhoneRow()); // providerRef: null

      const saved = await service.decideRequest(
        requestId,
        actorId,
        'in_review',
      );

      expect(saved.signals).toEqual({
        accountAgeDays: expect.any(Number) as number,
        priorRejections: 2,
        duplicateProviderRef: null,
      });
    });
  });

  // --- Phase 3 (Task 2): bulk decide, batched + transactional ---

  describe('bulkDecide', () => {
    it('applies the decision to every id via ONE batched load and ONE bulk save — no per-id findOne/save', async () => {
      requestRepo.find.mockResolvedValue([
        fakeRequest({
          id: 'request-1',
          status: VerificationRequestStatus.Pending,
        }),
        fakeRequest({
          id: 'request-2',
          status: VerificationRequestStatus.Pending,
        }),
      ]);

      const result = await service.bulkDecide(
        ['request-1', 'request-2'],
        actorId,
        'in_review',
      );

      expect(result).toEqual({
        succeeded: ['request-1', 'request-2'],
        failed: [],
      });
      expect(requestRepo.find).toHaveBeenCalledTimes(1);
      expect(requestRepo.find).toHaveBeenCalledWith({
        where: { id: In(['request-1', 'request-2']) },
      });
      // The single-id path (`decideRequest`'s own `findOne`/`save`) is never
      // touched by the batched path.
      expect(requestRepo.findOne).not.toHaveBeenCalled();
      expect(requestRepo.save).not.toHaveBeenCalled();
      // ONE transaction, ONE bulk save carrying both mutated rows.
      expect(requestRepo.manager.transaction).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'request-1',
          status: VerificationRequestStatus.InReview,
        }),
        expect.objectContaining({
          id: 'request-2',
          status: VerificationRequestStatus.InReview,
        }),
      ]);
      // in_review writes no event and sends no notification.
      expect(manager.insert).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('collects a per-id illegal transition as a failure instead of throwing, applying only the valid ones', async () => {
      requestRepo.find.mockResolvedValue([
        fakeRequest({
          id: 'request-1',
          status: VerificationRequestStatus.Pending,
          requestedLevel: VerificationLevel.IdVerified,
        }),
        fakeRequest({
          id: 'request-2',
          status: VerificationRequestStatus.Withdrawn, // terminal — approve is illegal
        }),
      ]);

      const result = await service.bulkDecide(
        ['request-1', 'request-2'],
        actorId,
        'approve',
      );

      expect(result.succeeded).toEqual(['request-1']);
      expect(result.failed).toEqual([
        {
          id: 'request-2',
          reason: expect.stringMatching(/cannot move/i) as string,
        },
      ]);
      // Only the valid request ever entered the transaction's bulk save —
      // the illegal-transition id never touched the DB.
      expect(manager.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'request-1',
            status: VerificationRequestStatus.Approved,
          }),
        ]),
      );
      expect(manager.save).not.toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'request-2' })]),
      );
    });

    it('collects a per-id "not found" as a failure instead of throwing', async () => {
      requestRepo.find.mockResolvedValue([
        fakeRequest({
          id: 'request-1',
          status: VerificationRequestStatus.Pending,
        }),
        // 'missing-request' is simply absent from the batched load's result.
      ]);

      const result = await service.bulkDecide(
        ['request-1', 'missing-request'],
        actorId,
        'in_review',
      );

      expect(result.succeeded).toEqual(['request-1']);
      expect(result.failed).toEqual([
        {
          id: 'missing-request',
          reason: expect.stringMatching(/not found/i) as string,
        },
      ]);
    });

    it('400s up front — before touching any id — when rejecting without a reason', async () => {
      await expect(
        service.bulkDecide(['request-1', 'request-2'], actorId, 'reject'),
      ).rejects.toThrow(/reason/i);
      expect(requestRepo.find).not.toHaveBeenCalled();
      expect(requestRepo.manager.transaction).not.toHaveBeenCalled();
    });

    it('applies a bulk reject with a reason to every id, writing one Rejected event per id and notifying', async () => {
      requestRepo.find.mockResolvedValue([
        fakeRequest({
          id: 'request-1',
          status: VerificationRequestStatus.Pending,
        }),
      ]);

      const result = await service.bulkDecide(
        ['request-1'],
        actorId,
        'reject',
        'evidence does not match the profile',
      );

      expect(result).toEqual({ succeeded: ['request-1'], failed: [] });
      // ONE bulk event insert (not a per-id `eventRepo.save`).
      expect(manager.insert).toHaveBeenCalledTimes(1);
      expect(manager.insert).toHaveBeenCalledWith(VerificationEvent, [
        expect.objectContaining({
          action: VerificationEventAction.Rejected,
          requestId: 'request-1',
          reason: 'evidence does not match the profile',
        }),
      ]);
      expect(manager.save).toHaveBeenCalledWith([
        expect.objectContaining({
          status: VerificationRequestStatus.Rejected,
          decisionReason: 'evidence does not match the profile',
        }),
      ]);
      // Post-commit notification, same payload shape `decideRequest` sends.
      expect(notifications.create).toHaveBeenCalledWith(
        userId,
        NotificationType.VerificationUpdate,
        expect.objectContaining({
          decision: 'rejected',
          reason: 'evidence does not match the profile',
        }),
      );
    });

    it('approve batch raises each member level, writes one Approved event per id, and notifies each — in ONE transaction', async () => {
      requestRepo.find.mockResolvedValue([
        fakeRequest({
          id: 'request-1',
          userId: 'member-1',
          status: VerificationRequestStatus.Pending,
          requestedLevel: VerificationLevel.IdVerified,
        }),
        fakeRequest({
          id: 'request-2',
          userId: 'member-2',
          status: VerificationRequestStatus.Pending,
          requestedLevel: VerificationLevel.Phone,
        }),
      ]);
      // member-1 already has a row (phone); member-2 has none — created via
      // `manager.create`, mirroring `loadOrCreate`.
      manager.find.mockResolvedValue([
        {
          userId: 'member-1',
          level: VerificationLevel.Phone,
          method: 'phone_otp',
          provider: 'dev_phone',
          providerRef: null,
          verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
          type: 'identity',
          grantedBy: VerificationGrantedBy.MemberEarned,
          reviewedByUserId: null,
        },
      ]);

      const result = await service.bulkDecide(
        ['request-1', 'request-2'],
        actorId,
        'approve',
      );

      expect(result).toEqual({
        succeeded: ['request-1', 'request-2'],
        failed: [],
      });

      // ONE transaction covers the whole valid set.
      expect(requestRepo.manager.transaction).toHaveBeenCalledTimes(1);
      // ONE bulk member-verification load for every distinct userId.
      expect(manager.find).toHaveBeenCalledTimes(1);
      expect(manager.find).toHaveBeenCalledWith(MemberVerification, {
        where: { userId: In(['member-1', 'member-2']) },
      });
      // ONE bulk event insert carrying both Approved events.
      expect(manager.insert).toHaveBeenCalledTimes(1);
      expect(manager.insert).toHaveBeenCalledWith(
        VerificationEvent,
        expect.arrayContaining([
          expect.objectContaining({
            action: VerificationEventAction.Approved,
            requestId: 'request-1',
            fromLevel: VerificationLevel.Phone,
            toLevel: VerificationLevel.IdVerified,
          }),
          expect.objectContaining({
            action: VerificationEventAction.Approved,
            requestId: 'request-2',
            toLevel: VerificationLevel.Phone,
          }),
        ]),
      );
      // TWO bulk saves total: the member rows, then the request rows —
      // never a per-id save.
      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            userId: 'member-1',
            level: VerificationLevel.IdVerified,
            grantedBy: VerificationGrantedBy.AdminGranted,
            reviewedByUserId: actorId,
          }),
          expect.objectContaining({
            userId: 'member-2',
            level: VerificationLevel.Phone,
            grantedBy: VerificationGrantedBy.AdminGranted,
          }),
        ]),
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'request-1',
            status: VerificationRequestStatus.Approved,
          }),
          expect.objectContaining({
            id: 'request-2',
            status: VerificationRequestStatus.Approved,
          }),
        ]),
      );

      // Post-commit, per-recipient notifications — same payload shape
      // `decideRequest` sends, unconditionally (not gated on a level change).
      expect(notifications.create).toHaveBeenCalledTimes(2);
      expect(notifications.create).toHaveBeenCalledWith(
        'member-1',
        NotificationType.VerificationUpdate,
        expect.objectContaining({
          requestedLevel: VerificationLevel.IdVerified,
          decision: 'approved',
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'member-2',
        NotificationType.VerificationUpdate,
        expect.objectContaining({
          requestedLevel: VerificationLevel.Phone,
          decision: 'approved',
        }),
      );
    });

    it('a notification failure for one recipient is logged and skipped — it neither blocks the other recipient nor throws out of bulkDecide (already-committed writes cannot roll back)', async () => {
      requestRepo.find.mockResolvedValue([
        fakeRequest({
          id: 'request-1',
          userId: 'member-1',
          status: VerificationRequestStatus.Pending,
        }),
        fakeRequest({
          id: 'request-2',
          userId: 'member-2',
          status: VerificationRequestStatus.Pending,
        }),
      ]);
      notifications.create
        .mockRejectedValueOnce(new Error('notification service unreachable'))
        .mockResolvedValueOnce(null);

      const result = await service.bulkDecide(
        ['request-1', 'request-2'],
        actorId,
        'reject',
        'evidence does not match the profile',
      );

      // The batch itself already committed — both ids report succeeded
      // regardless of the notify failure for one of them.
      expect(result).toEqual({
        succeeded: ['request-1', 'request-2'],
        failed: [],
      });
      // Both recipients were still attempted — the failure on member-1
      // didn't abort the loop before reaching member-2.
      expect(notifications.create).toHaveBeenCalledTimes(2);
      expect(notifications.create).toHaveBeenCalledWith(
        'member-1',
        NotificationType.VerificationUpdate,
        expect.objectContaining({ decision: 'rejected' }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'member-2',
        NotificationType.VerificationUpdate,
        expect.objectContaining({ decision: 'rejected' }),
      );
    });
  });

  // --- Task 6: dormant the automated seams ---

  describe('automated elevation flag (Task 6)', () => {
    describe('handleIdentityCallback', () => {
      const pendingIdentityRow = () => ({
        userId,
        level: VerificationLevel.Email,
        providerRef: 'ref-1',
        method: null,
        provider: 'stub_identity',
        verifiedAt: null,
      });

      it('does NOT raise the level when the flag is false (default)', async () => {
        configValues.VERIFICATION_AUTOMATED_ELEVATION = undefined;
        repo.findOne.mockResolvedValue(pendingIdentityRow());

        await service.handleIdentityCallback({ providerRef: 'ref-1' });

        expect(repo.save).not.toHaveBeenCalled();
      });

      it('raises the level when the flag is true', async () => {
        configValues.VERIFICATION_AUTOMATED_ELEVATION = 'true';
        repo.findOne.mockResolvedValue(pendingIdentityRow());

        await service.handleIdentityCallback({ providerRef: 'ref-1' });

        expect(repo.save).toHaveBeenCalledWith(
          expect.objectContaining({ level: VerificationLevel.IdVerified }),
        );
      });
    });
  });
});
