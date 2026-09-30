import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { SignupRejectedError } from '../auth/errors/signup-rejected.error';
import { EmailSuppression } from '../account/entities/email-suppression.entity';
import { Invite, InviteStatus } from './entities/invite.entity';
import { resolveInviteStatus, toPublicInviteView } from './invite-response';
import { InvitesService } from './invites.service';
import { RecognitionEntitlementsService } from '../recognition/recognition-entitlements.service';
import { AmbassadorStatusService } from '../ambassadors/ambassador-status.service';

// NOTE: the `InvitesService.acceptInvite` suite that used to sit here is gone
// along with the method and the `POST /invites/:code/accept` route. The route
// was unreachable by construction — it required a JWT, and holding a JWT means
// you already have an account, which you can only get by redeeming an invite at
// Google sign-up (`validateInviteForSignup` + `claimInvite`, covered below and
// in auth.service.spec.ts). Its last precondition, `redeemer.status ===
// 'pending'`, referenced a status that no longer exists.

describe('resolveInviteStatus', () => {
  const base = {
    expiresAt: new Date('2026-07-07T00:00:00.000Z'),
  } as Invite;
  const now = new Date('2026-06-30T00:00:00.000Z');

  it("maps a pending, unexpired invite to 'valid'", () => {
    expect(
      resolveInviteStatus({ ...base, status: InviteStatus.Pending }, now),
    ).toBe('valid');
  });

  it("maps a pending invite past expires_at to 'expired'", () => {
    expect(
      resolveInviteStatus(
        {
          ...base,
          status: InviteStatus.Pending,
          expiresAt: new Date('2026-06-01T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe('expired');
  });

  it("maps an accepted invite to 'used' (even if not yet past expiry)", () => {
    expect(
      resolveInviteStatus({ ...base, status: InviteStatus.Accepted }, now),
    ).toBe('used');
  });

  it("maps a revoked invite to 'revoked'", () => {
    expect(
      resolveInviteStatus({ ...base, status: InviteStatus.Revoked }, now),
    ).toBe('revoked');
  });

  it("maps an explicitly-expired invite to 'expired'", () => {
    expect(
      resolveInviteStatus({ ...base, status: InviteStatus.Expired }, now),
    ).toBe('expired');
  });
});

describe('toPublicInviteView', () => {
  const now = new Date('2026-06-30T00:00:00.000Z');
  const invite = {
    code: 'QP-7F3K-2026',
    status: InviteStatus.Pending,
    note: "I've been part of this community for two years now...",
    vouch: 'Why they belong here.',
    createdAt: new Date('2026-06-23T10:42:00.000Z'),
    expiresAt: new Date('2026-07-07T10:42:00.000Z'),
  } as Invite;
  const inviter = {
    status: UserStatus.Active,
    activatedAt: new Date('2024-03-01T00:00:00.000Z'),
    createdAt: new Date('2024-02-01T00:00:00.000Z'),
    profile: {
      slug: 'ines',
      firstName: 'Inês',
      lastName: 'Tavares',
      avatarUrl: 'https://cdn/ines.jpg',
    },
  } as unknown as User;

  it('builds the public payload with the configured validity window', () => {
    const view = toPublicInviteView(invite, inviter, 247, now, false);
    expect(view).toEqual({
      code: 'QP-7F3K-2026',
      status: 'valid',
      expiresAt: '2026-07-07T10:42:00.000Z',
      validForDays: 14, // created_at -> expires_at window
      memberCount: 247,
      inviter: {
        slug: 'ines',
        firstName: 'Inês',
        lastName: 'Tavares',
        avatarUrl: 'https://cdn/ines.jpg',
        memberSince: '2024',
        isAmbassador: false,
      },
      // An active inviter maps to `inviterActive: true`; an erased or
      // non-active inviter reads as inactive (see the null-inviter test).
      inviterActive: true,
      note: "I've been part of this community for two years now...",
      vouch: 'Why they belong here.',
    });
  });

  it('exposes no inviter ids/emails — only the whitelisted public fields', () => {
    const view = toPublicInviteView(invite, inviter, 1, now, false);
    expect(Object.keys(view.inviter).sort()).toEqual(
      [
        'avatarUrl',
        'firstName',
        'isAmbassador',
        'lastName',
        'memberSince',
        'slug',
      ].sort(),
    );
  });

  it('returns null note/vouch and null avatar when absent, omitting memberSince when no inviter', () => {
    const view = toPublicInviteView(
      { ...invite, note: null, vouch: null },
      null,
      0,
      now,
      false,
    );
    expect(view.note).toBeNull();
    expect(view.vouch).toBeNull();
    expect(view.inviter.avatarUrl).toBeNull();
    expect(view.inviter).not.toHaveProperty('memberSince');
  });

  it('sets isAmbassador on the inviter block from the given flag', () => {
    const view = toPublicInviteView(invite, inviter, 247, now, true);
    expect(view.inviter.isAmbassador).toBe(true);
  });
});

describe('InvitesService.resolveInvite', () => {
  let service: InvitesService;
  let repo: { findOne: jest.Mock };
  let users: {
    findByIdWithProfile: jest.Mock;
    countActiveMembers: jest.Mock;
  };
  let ambassadorStatus: { isVisibleAmbassador: jest.Mock };

  const buildInviterUser = () => ({
    id: 'inviter',
    status: UserStatus.Active,
    activatedAt: new Date('2024-03-01T00:00:00.000Z'),
    createdAt: new Date('2024-02-01T00:00:00.000Z'),
    profile: {
      slug: 'ines',
      firstName: 'Inês',
      lastName: 'Tavares',
      avatarUrl: null,
    },
  });

  beforeEach(async () => {
    repo = { findOne: jest.fn() };
    users = {
      findByIdWithProfile: jest.fn(),
      countActiveMembers: jest.fn().mockResolvedValue(247),
    };
    ambassadorStatus = {
      isVisibleAmbassador: jest.fn().mockResolvedValue(false),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: repo },
        { provide: UsersService, useValue: users },
        { provide: DataSource, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        // SUS-04: the invite quota now adds a recognition bonus on top of the
        // configured base. These suites cover the base/override behaviour, so
        // the bonus is stubbed at 0 throughout.
        {
          provide: RecognitionEntitlementsService,
          useValue: { getInviteQuotaBonus: jest.fn().mockResolvedValue(0) },
        },
        { provide: AmbassadorStatusService, useValue: ambassadorStatus },
        { provide: ConfigService, useValue: { get: jest.fn(() => 1) } },
      ],
    }).compile();
    service = module.get(InvitesService);
  });

  it('throws NotFoundException for an unknown code', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.resolveInvite('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('resolves a valid invite into the public view', async () => {
    repo.findOne.mockResolvedValue({
      code: 'QP-7F3K-2026',
      inviterId: 'inviter',
      status: InviteStatus.Pending,
      note: 'hello',
      createdAt: new Date('2026-06-23T10:42:00.000Z'),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    users.findByIdWithProfile.mockResolvedValue(buildInviterUser());

    const view = await service.resolveInvite('QP-7F3K-2026');

    expect(users.findByIdWithProfile).toHaveBeenCalledWith('inviter');
    expect(view.status).toBe('valid');
    expect(view.memberCount).toBe(247);
    expect(view.inviter.slug).toBe('ines');
    expect(view.note).toBe('hello');
  });

  // Review Focus 2: the frontend only counts isAmbassador === true, so a
  // hidden tag must read as false even with an active grant underneath it.
  it('flags the inviter as an ambassador only when their tag is visible', async () => {
    repo.findOne.mockResolvedValue({
      code: 'QP-7F3K-2026',
      inviterId: 'inviter',
      status: InviteStatus.Pending,
      note: null,
      createdAt: new Date('2026-06-23T10:42:00.000Z'),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    users.findByIdWithProfile.mockResolvedValue(buildInviterUser());

    ambassadorStatus.isVisibleAmbassador.mockResolvedValue(true);
    const visibleView = await service.resolveInvite('QP-7F3K-2026');
    expect(visibleView.inviter.isAmbassador).toBe(true);

    // Hidden tag, even with an active grant underneath. isVisibleAmbassador
    // is the single source of truth here and already folds that in.
    ambassadorStatus.isVisibleAmbassador.mockResolvedValue(false);
    const hiddenView = await service.resolveInvite('QP-7F3K-2026');
    expect(hiddenView.inviter.isAmbassador).toBe(false);
  });

  it('never checks ambassador status when the invite has no resolvable inviter', async () => {
    repo.findOne.mockResolvedValue({
      code: 'QP-7F3K-2026',
      inviterId: 'gone',
      status: InviteStatus.Pending,
      note: null,
      createdAt: new Date('2026-06-23T10:42:00.000Z'),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    users.findByIdWithProfile.mockResolvedValue(null);

    const view = await service.resolveInvite('QP-7F3K-2026');

    expect(view.inviter.isAmbassador).toBe(false);
    expect(ambassadorStatus.isVisibleAmbassador).not.toHaveBeenCalled();
  });

  it('never flags an inactive inviter as an ambassador', async () => {
    repo.findOne.mockResolvedValue({
      code: 'QP-7F3K-2026',
      inviterId: 'inviter',
      status: InviteStatus.Pending,
      note: null,
      createdAt: new Date('2026-06-23T10:42:00.000Z'),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    users.findByIdWithProfile.mockResolvedValue({
      ...buildInviterUser(),
      status: UserStatus.Suspended,
    });
    ambassadorStatus.isVisibleAmbassador.mockResolvedValue(true);

    const view = await service.resolveInvite('QP-7F3K-2026');

    expect(view.inviter.isAmbassador).toBe(false);
    expect(view.inviterActive).toBe(false);
    expect(ambassadorStatus.isVisibleAmbassador).not.toHaveBeenCalled();
  });
});

describe('InvitesService.getQuota', () => {
  let service: InvitesService;
  let invitesRepo: { count: jest.Mock };
  let users: { findById: jest.Mock; countActiveMembers: jest.Mock };
  let config: { get: jest.Mock };
  let recognitionEntitlements: { getInviteQuotaBonus: jest.Mock };
  let ambassadorStatus: { getInviteBonus: jest.Mock };

  const build = async () => {
    invitesRepo = { count: jest.fn().mockResolvedValue(0) };
    users = {
      findById: jest.fn().mockResolvedValue(null),
      countActiveMembers: jest.fn().mockResolvedValue(247),
    };
    config = { get: jest.fn(() => 5) };
    recognitionEntitlements = {
      getInviteQuotaBonus: jest.fn().mockResolvedValue(0),
    };
    ambassadorStatus = { getInviteBonus: jest.fn().mockResolvedValue(0) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: invitesRepo },
        { provide: UsersService, useValue: users },
        { provide: DataSource, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        // SUS-04: the invite quota now adds a recognition bonus on top of the
        // configured base. These suites cover the base/override behaviour, so
        // the bonus is stubbed at 0 unless a case overrides it.
        {
          provide: RecognitionEntitlementsService,
          useValue: recognitionEntitlements,
        },
        { provide: AmbassadorStatusService, useValue: ambassadorStatus },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(InvitesService);
  };

  beforeEach(build);

  it('adds the ambassador bonus on top of base and level bonus', async () => {
    // Base 5 (config default), levelBonus 2, ambassador bonus 10 -> limit 17.
    recognitionEntitlements.getInviteQuotaBonus.mockResolvedValue(2);
    ambassadorStatus.getInviteBonus.mockResolvedValue(10);

    const quota = await service.getQuota('inviter');

    expect(quota.limit).toBe(17);
  });

  it('lets a per-user quota override replace the ambassador bonus too', async () => {
    users.findById.mockResolvedValue({ inviteMonthlyQuota: 3 });
    ambassadorStatus.getInviteBonus.mockResolvedValue(10);

    const quota = await service.getQuota('inviter');

    expect(quota.limit).toBe(3);
  });

  it('uses the config default when the member has no override', async () => {
    users.findById.mockResolvedValue(null);
    invitesRepo.count.mockResolvedValue(2);
    const quota = await service.getQuota('inviter');
    expect(quota.limit).toBe(5);
    expect(quota.used).toBe(2);
    expect(quota.remaining).toBe(3);
  });

  it('prefers the per-user override over the config default', async () => {
    users.findById.mockResolvedValue({ inviteMonthlyQuota: 1 });
    invitesRepo.count.mockResolvedValue(0);
    const quota = await service.getQuota('inviter');
    expect(quota.limit).toBe(1);
    expect(quota.remaining).toBe(1);
  });

  it('floors remaining at 0 when the allowance is spent', async () => {
    users.findById.mockResolvedValue({ inviteMonthlyQuota: 2 });
    invitesRepo.count.mockResolvedValue(3); // over the limit
    const quota = await service.getQuota('inviter');
    expect(quota.remaining).toBe(0);
  });

  it('reports the live community size alongside the allowance', async () => {
    users.countActiveMembers.mockResolvedValue(312);
    const quota = await service.getQuota('inviter');
    expect(quota.memberCount).toBe(312);
  });

  it('resetsAt is the 1st of next month (UTC), rolling the year over in Dec', async () => {
    const quota = await service.getQuota('inviter');
    // resetsAt is always the 1st at 00:00 UTC of some month...
    const reset = new Date(quota.resetsAt);
    expect(reset.getUTCDate()).toBe(1);
    expect(reset.getUTCHours()).toBe(0);
    expect(reset.getUTCMinutes()).toBe(0);
  });
});

describe('InvitesService.createInvite', () => {
  let service: InvitesService;
  let invitesRepo: { exists: jest.Mock; update: jest.Mock };
  // The quota check + insert now run inside a transaction against a manager;
  // the inviter row is read under a pessimistic lock (userRepo.findOne).
  let userRepo: { findOne: jest.Mock };
  let manager: {
    getRepository: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let config: { get: jest.Mock };

  const build = async (quota = 1) => {
    invitesRepo = {
      exists: jest.fn().mockResolvedValue(false),
      // PRD-02's `startApprovalRedemptionWindow` writes through the plain repo,
      // outside any caller transaction.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    // Default: no per-user override, so the quota check falls back to config.
    userRepo = { findOne: jest.fn().mockResolvedValue(null) };
    manager = {
      getRepository: jest.fn(() => userRepo),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((_entity: unknown, value: Partial<Invite>) => value),
      save: jest.fn((value: Invite) => Promise.resolve(value)),
    };
    config = { get: jest.fn(() => quota) };
    const dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          (
            runInTransaction: (
              entityManager: typeof manager,
            ) => Promise<unknown>,
          ) => runInTransaction(manager),
        ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: invitesRepo },
        { provide: UsersService, useValue: { findById: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        // SUS-04: the invite quota now adds a recognition bonus on top of the
        // configured base. These suites cover the base/override behaviour, so
        // the bonus is stubbed at 0 throughout.
        {
          provide: RecognitionEntitlementsService,
          useValue: { getInviteQuotaBonus: jest.fn().mockResolvedValue(0) },
        },
        // Same SUS-04 rationale: stubbed at 0 so these suites stay focused on
        // base/override behaviour.
        {
          provide: AmbassadorStatusService,
          useValue: { getInviteBonus: jest.fn().mockResolvedValue(0) },
        },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(InvitesService);
  };

  beforeEach(() => build());

  it('returns the minimal { code, expiresAt, status } view', async () => {
    const before = Date.now();
    const view = await service.createInvite('inviter', { note: 'hi' });

    expect(view.status).toBe('valid');
    expect(Object.keys(view).sort()).toEqual(['code', 'expiresAt', 'status']);
    // expires 7 days out (allow a small execution window).
    const ttl = view.expiresAt.getTime() - before;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(ttl).toBeGreaterThanOrEqual(sevenDays - 1000);
    expect(ttl).toBeLessThanOrEqual(sevenDays + 5000);
  });

  it('mints a QP-XXXX-YYYY code from the unambiguous alphabet', async () => {
    const view = await service.createInvite('inviter');
    expect(view.code).toMatch(/^QP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('regenerates the code on collision before persisting', async () => {
    invitesRepo.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await service.createInvite('inviter');
    expect(invitesRepo.exists).toHaveBeenCalledTimes(2);
  });

  it('inserts under the caller transaction, not the bare repository', async () => {
    await service.createInvite('inviter', { note: 'hi' });
    expect(manager.save).toHaveBeenCalled();
  });

  it('trims the note and stores empty/whitespace as null', async () => {
    await service.createInvite('inviter', { note: '  hello  ' });
    expect(manager.create).toHaveBeenCalledWith(
      Invite,
      expect.objectContaining({ note: 'hello' }),
    );

    manager.create.mockClear();
    await service.createInvite('inviter', { note: '   ' });
    expect(manager.create).toHaveBeenCalledWith(
      Invite,
      expect.objectContaining({ note: null }),
    );

    manager.create.mockClear();
    await service.createInvite('inviter');
    expect(manager.create).toHaveBeenCalledWith(
      Invite,
      expect.objectContaining({ note: null }),
    );
  });

  it('trims the vouch and stores empty/whitespace as null', async () => {
    await service.createInvite('inviter', { vouch: '  why they belong  ' });
    expect(manager.create).toHaveBeenCalledWith(
      Invite,
      expect.objectContaining({ vouch: 'why they belong' }),
    );

    manager.create.mockClear();
    await service.createInvite('inviter', { vouch: '   ' });
    expect(manager.create).toHaveBeenCalledWith(
      Invite,
      expect.objectContaining({ vouch: null }),
    );
  });

  // ENG-496: the mint used to 409 an erasure-suppressed address, which told any
  // member that the address once had an account and erased it. The mock
  // DataSource here has no `getRepository`, so a lookup through it would throw,
  // and the transaction manager's `getRepository` must never be handed the
  // suppression entity either.
  it('mints an email-pinned invite without consulting the suppression list', async () => {
    await expect(
      service.createInvite('inviter', { email: '  Erased@Example.com ' }),
    ).resolves.toMatchObject({ status: 'valid' });
    expect(manager.getRepository).not.toHaveBeenCalledWith(EmailSuppression);
    expect(manager.create).toHaveBeenCalledWith(
      Invite,
      expect.objectContaining({ email: 'erased@example.com' }),
    );
    expect(manager.save).toHaveBeenCalled();
  });

  it('rejects with 403 when the monthly quota is exhausted', async () => {
    await build(1);
    manager.count.mockResolvedValue(1); // already used this month's allowance

    await expect(
      service.createInvite('inviter', { note: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('carries the typed INVITE_QUOTA_EXCEEDED code in the 403 body', async () => {
    await build(1);
    manager.count.mockResolvedValue(1);

    await expect(service.createInvite('inviter')).rejects.toMatchObject({
      response: {
        statusCode: 403,
        error: 'Forbidden',
        code: 'INVITE_QUOTA_EXCEEDED',
      },
    });
  });

  it('locks the inviter row and uses its per-user quota override', async () => {
    await build(1); // global default is 1
    userRepo.findOne.mockResolvedValue({ inviteMonthlyQuota: 3 });
    manager.count.mockResolvedValue(2); // 2 used, override allows 3

    await expect(service.createInvite('inviter')).resolves.toBeDefined();
    expect(userRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'inviter' },
      lock: { mode: 'pessimistic_write' },
    });

    manager.count.mockResolvedValue(3); // now at the override limit
    await expect(service.createInvite('inviter')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('counts only invites created since the start of the UTC month', async () => {
    await service.createInvite('inviter');
    const countArgs = manager.count.mock.calls[0] as [
      unknown,
      { where: { inviterId: string; createdAt: { value: Date } } },
    ];
    const where = countArgs[1].where;
    expect(where.inviterId).toBe('inviter');
    // MoreThanOrEqual(monthStart) — assert the boundary is the 1st at 00:00 UTC.
    const boundary: Date = where.createdAt.value;
    expect(boundary.getUTCDate()).toBe(1);
    expect(boundary.getUTCHours()).toBe(0);
    expect(boundary.getUTCMinutes()).toBe(0);
  });

  describe('createInviteForApproval', () => {
    it('mints on the CALLER transaction manager, bound to the email', async () => {
      // A manager distinct from the one dataSource.transaction would hand out,
      // so "did it use the caller's?" is actually observable.
      const callerManager = {
        getRepository: jest.fn(() => userRepo),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn((_entity: unknown, value: Partial<Invite>) => value),
        save: jest.fn((value: Partial<Invite>) =>
          Promise.resolve({ id: 'inv-new', ...value }),
        ),
      };

      const result = await service.createInviteForApproval(
        callerManager as never,
        'admin-1',
        'applicant@x.com',
      );

      expect(callerManager.save).toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
      expect(callerManager.create).toHaveBeenCalledWith(
        Invite,
        expect.objectContaining({
          inviterId: 'admin-1',
          email: 'applicant@x.com',
          status: InviteStatus.Pending,
        }),
      );
      expect(result.id).toBe('inv-new');
      expect(result.code).toMatch(/^QP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    });

    it('skips the monthly quota so an admin can clear the queue', async () => {
      // Quota of 1, already spent. createInvite would 403 here.
      await build(1);
      const callerManager = {
        getRepository: jest.fn(() => userRepo),
        count: jest.fn().mockResolvedValue(5),
        create: jest.fn((_entity: unknown, value: Partial<Invite>) => value),
        save: jest.fn((value: Partial<Invite>) =>
          Promise.resolve({ id: 'inv-new', ...value }),
        ),
      };

      await expect(
        service.createInviteForApproval(
          callerManager as never,
          'admin-1',
          'applicant@x.com',
        ),
      ).resolves.toEqual(expect.objectContaining({ id: 'inv-new' }));
      // The quota path was never entered at all.
      expect(callerManager.count).not.toHaveBeenCalled();
    });

    // PRD-02. An approval invite has nobody to hand it over: the platform
    // sends no email, so approval is a moment only the reviewer knows about.
    // The mint therefore gets a SHELF life, and the short redemption window is
    // started later, when the applicant first reads the code.
    it('mints with the long SHELF life, not the 7-day redemption window', async () => {
      const before = Date.now();
      const callerManager = {
        getRepository: jest.fn(() => userRepo),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn((_entity: unknown, value: Partial<Invite>) => value),
        save: jest.fn((value: Partial<Invite>) =>
          Promise.resolve({ id: 'inv-new', ...value }),
        ),
      };

      const result = await service.createInviteForApproval(
        callerManager as never,
        'admin-1',
        'applicant@x.com',
      );

      const ttl = (result.expiresAt as Date).getTime() - before;
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      expect(ttl).toBeGreaterThanOrEqual(thirtyDays - 1000);
      expect(ttl).toBeLessThanOrEqual(thirtyDays + 5000);
    });
  });

  describe('startApprovalRedemptionWindow', () => {
    it('re-pins the expiry to seven days from the moment given', async () => {
      const now = new Date('2026-07-21T00:00:00.000Z');

      const expiry = await service.startApprovalRedemptionWindow('inv-1', now);

      expect(expiry.toISOString()).toBe('2026-07-28T00:00:00.000Z');
      expect(invitesRepo.update).toHaveBeenCalledWith(
        { id: 'inv-1', status: InviteStatus.Pending },
        { expiresAt: expiry },
      );
    });

    it('is conditional on Pending, so it cannot revive a spent invite', async () => {
      await service.startApprovalRedemptionWindow('inv-1', new Date());

      const [criteria] = invitesRepo.update.mock.calls[0] as [
        { status: InviteStatus },
      ];
      expect(criteria.status).toBe(InviteStatus.Pending);
    });
  });
});

describe('InvitesService.listMyInvites', () => {
  let service: InvitesService;
  let repo: { find: jest.Mock };
  // `listMyInvites` batch-resolves the redeemers of *accepted* invites via
  // `usersService.findByIdsWithProfile`. The rows below are pending, so it's
  // called with an empty id list and returns no users.
  let users: { findByIdsWithProfile: jest.Mock };

  beforeEach(async () => {
    repo = { find: jest.fn().mockResolvedValue([]) };
    users = { findByIdsWithProfile: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: repo },
        { provide: UsersService, useValue: users },
        { provide: DataSource, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        // SUS-04: the invite quota now adds a recognition bonus on top of the
        // configured base. These suites cover the base/override behaviour, so
        // the bonus is stubbed at 0 throughout.
        {
          provide: RecognitionEntitlementsService,
          useValue: { getInviteQuotaBonus: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: AmbassadorStatusService,
          useValue: { getInviteBonus: jest.fn().mockResolvedValue(0) },
        },
        { provide: ConfigService, useValue: { get: jest.fn(() => 1) } },
      ],
    }).compile();
    service = module.get(InvitesService);
  });

  it('maps to whitelisted MyInviteView rows (no raw entity / internal ids)', async () => {
    repo.find.mockResolvedValue([
      {
        id: 'internal-id',
        inviterId: 'inviter',
        acceptedBy: 'someone',
        code: 'QP-AAAA-BBBB',
        email: 'x@y.z',
        note: 'hi',
        vouch: 'why',
        status: InviteStatus.Pending,
        expiresAt: new Date('2026-07-12T00:00:00.000Z'),
        createdAt: new Date('2026-07-05T00:00:00.000Z'),
      },
    ]);
    const rows = await service.listMyInvites('inviter', { limit: 10 });
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inviterId: 'inviter' },
        take: 10,
        skip: 0,
      }),
    );
    // MyInviteView deliberately carries the invite `id` (the stable handle the
    // revoke/resend routes target) and an `acceptedBy` redeemer summary
    // (populated only for a 'used' invite; null here). It still never leaks the
    // inviter's own internal fields such as `inviterId`.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'acceptedBy',
        'code',
        'createdAt',
        'email',
        'expiresAt',
        'id',
        'note',
        'status',
        'vouch',
      ].sort(),
    );
    expect(rows[0]!.id).toBe('internal-id');
    expect(rows[0]!.acceptedBy).toBeNull();
    expect(rows[0]).not.toHaveProperty('inviterId');
    expect(rows[0]!.expiresAt).toBe('2026-07-12T00:00:00.000Z');
  });

  it('recomputes status so a not-yet-swept expiry reads as expired', async () => {
    repo.find.mockResolvedValue([
      {
        code: 'QP-AAAA-BBBB',
        email: null,
        note: null,
        vouch: null,
        status: InviteStatus.Pending, // stale in the DB
        expiresAt: new Date('2000-01-01T00:00:00.000Z'), // long past
        createdAt: new Date('1999-12-01T00:00:00.000Z'),
      },
    ]);
    const rows = await service.listMyInvites('inviter');
    expect(rows[0]!.status).toBe('expired');
  });
});

describe('InvitesService.validateInviteForSignup + claimInvite', () => {
  let service: InvitesService;
  let usersService: { findById: jest.Mock };

  beforeEach(async () => {
    usersService = { findById: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: {} },
        { provide: UsersService, useValue: usersService },
        { provide: DataSource, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        // SUS-04: the invite quota now adds a recognition bonus on top of the
        // configured base. These suites cover the base/override behaviour, so
        // the bonus is stubbed at 0 throughout.
        {
          provide: RecognitionEntitlementsService,
          useValue: { getInviteQuotaBonus: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: AmbassadorStatusService,
          useValue: { getInviteBonus: jest.fn().mockResolvedValue(0) },
        },
        { provide: ConfigService, useValue: { get: jest.fn(() => 1) } },
      ],
    }).compile();
    service = module.get(InvitesService);
  });

  describe('validateInviteForSignup', () => {
    const makeManager = (invite: Partial<Invite> | null) =>
      ({
        getRepository: () => ({
          findOne: jest.fn().mockResolvedValue(invite),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      }) as unknown as EntityManager;

    it('returns inviteId, inviterId, personal, and vouch for a valid pending invite', async () => {
      usersService.findById = jest
        .fn()
        .mockResolvedValue({ id: 'inviter-1', status: UserStatus.Active });
      const manager = makeManager({
        id: 'inv-1',
        inviterId: 'inviter-1',
        status: InviteStatus.Pending,
        email: null,
        personal: true,
        vouch: 'you belong here',
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.validateInviteForSignup(manager, 'CODE', 'a@b.c'),
      ).resolves.toEqual({
        inviteId: 'inv-1',
        inviterId: 'inviter-1',
        personal: true,
        vouch: 'you belong here',
      });
    });

    it('rejects an unknown / non-pending invite', async () => {
      const manager = makeManager(null);
      await expect(
        service.validateInviteForSignup(manager, 'CODE', 'a@b.c'),
      ).rejects.toBeInstanceOf(SignupRejectedError);
    });

    it('rejects when the invite is bound to a different email', async () => {
      const manager = makeManager({
        id: 'inv-1',
        inviterId: 'inviter-1',
        status: InviteStatus.Pending,
        email: 'someone@else.com',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        service.validateInviteForSignup(manager, 'CODE', 'a@b.c'),
      ).rejects.toBeInstanceOf(SignupRejectedError);
    });

    it('rejects when the inviter is not active', async () => {
      usersService.findById = jest
        .fn()
        .mockResolvedValue({ id: 'inviter-1', status: UserStatus.Suspended });
      const manager = makeManager({
        id: 'inv-1',
        inviterId: 'inviter-1',
        status: InviteStatus.Pending,
        email: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        service.validateInviteForSignup(manager, 'CODE', 'a@b.c'),
      ).rejects.toBeInstanceOf(SignupRejectedError);
    });
  });

  describe('claimInvite', () => {
    it('throws when the conditional claim affects no rows (already used)', async () => {
      const manager = {
        getRepository: () => ({
          update: jest.fn().mockResolvedValue({ affected: 0 }),
        }),
      } as unknown as EntityManager;
      await expect(
        service.claimInvite(manager, 'inv-1', 'new-user'),
      ).rejects.toBeInstanceOf(SignupRejectedError);
    });

    it('resolves when exactly one row is claimed', async () => {
      const update = jest.fn().mockResolvedValue({ affected: 1 });
      const manager = {
        getRepository: () => ({ update }),
      } as unknown as EntityManager;
      await expect(
        service.claimInvite(manager, 'inv-1', 'new-user'),
      ).resolves.toBeUndefined();
      expect(update).toHaveBeenCalledWith(
        { id: 'inv-1', status: InviteStatus.Pending },
        {
          status: InviteStatus.Accepted,
          acceptedBy: 'new-user',
          usedAt: expect.any(Date) as unknown,
        },
      );
    });
  });
});
