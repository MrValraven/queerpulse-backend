import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { SignupRejectedError } from '../auth/errors/signup-rejected.error';
import { Invite, InviteStatus } from './entities/invite.entity';
import { resolveInviteStatus, toPublicInviteView } from './invite-response';
import { InvitesService } from './invites.service';

describe('InvitesService.acceptInvite', () => {
  let service: InvitesService;
  let repo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let users: { findById: jest.Mock; promoteToActive: jest.Mock };
  let manager: { update: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  const currentUser = { userId: 'u-new', email: 'new@x.com' };

  // inviter is active; the redeemer (currentUser) is pending — unless overridden.
  const activeInviterPendingRedeemer = async (id: string) =>
    id === 'inviter'
      ? { id: 'inviter', status: UserStatus.Active }
      : { id, status: UserStatus.Pending };

  beforeEach(async () => {
    repo = { findOne: jest.fn(), save: jest.fn(), update: jest.fn() };
    manager = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
    };
    users = {
      findById: jest.fn(),
      promoteToActive: jest.fn().mockResolvedValue(true),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: repo },
        { provide: UsersService, useValue: users },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 1) } },
      ],
    }).compile();
    service = module.get(InvitesService);
  });

  const pendingInvite = (overrides = {}) => ({
    id: 'i1',
    inviterId: 'inviter',
    code: 'c',
    email: null,
    status: InviteStatus.Pending,
    expiresAt: null,
    ...overrides,
  });

  it('rejects an unknown or already-used invite', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(
      service.acceptInvite('nope', currentUser),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the inviter is not an active member', async () => {
    repo.findOne.mockResolvedValue(pendingInvite());
    users.findById.mockResolvedValue({
      id: 'inviter',
      status: UserStatus.Pending,
    });
    await expect(service.acceptInvite('c', currentUser)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects when the redeemer is already an active member', async () => {
    repo.findOne.mockResolvedValue(pendingInvite());
    users.findById.mockImplementation(async (id) => ({
      id,
      status: UserStatus.Active,
    }));
    await expect(service.acceptInvite('c', currentUser)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('accepts a valid invite: atomically claims it and promotes the user', async () => {
    repo.findOne.mockResolvedValue(pendingInvite());
    users.findById.mockImplementation(activeInviterPendingRedeemer);

    await service.acceptInvite('c', currentUser);

    expect(manager.update).toHaveBeenCalledWith(
      Invite,
      { id: 'i1', status: InviteStatus.Pending },
      expect.objectContaining({
        status: InviteStatus.Accepted,
        acceptedBy: 'u-new',
        usedAt: expect.any(Date),
      }),
    );
    expect(users.promoteToActive).toHaveBeenCalledWith(
      'u-new',
      expect.objectContaining({ invitedBy: 'inviter', manager }),
    );
  });

  it('rejects the claim when the invite was concurrently consumed', async () => {
    repo.findOne.mockResolvedValue(pendingInvite());
    users.findById.mockImplementation(activeInviterPendingRedeemer);
    manager.update.mockResolvedValue({ affected: 0 }); // lost the race

    await expect(service.acceptInvite('c', currentUser)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(users.promoteToActive).not.toHaveBeenCalled();
  });

  it('rejects an invite bound to a different email', async () => {
    repo.findOne.mockResolvedValue(
      pendingInvite({ email: 'someone-else@x.com' }),
    );
    users.findById.mockResolvedValue({
      id: 'inviter',
      status: UserStatus.Active,
    });
    await expect(service.acceptInvite('c', currentUser)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

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
    const view = toPublicInviteView(invite, inviter, 247, now);
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
      },
      note: "I've been part of this community for two years now...",
      vouch: 'Why they belong here.',
    });
  });

  it('exposes no inviter ids/emails — only the whitelisted public fields', () => {
    const view = toPublicInviteView(invite, inviter, 1, now);
    expect(Object.keys(view.inviter).sort()).toEqual(
      ['avatarUrl', 'firstName', 'lastName', 'memberSince', 'slug'].sort(),
    );
  });

  it('returns null note/vouch and null avatar when absent, omitting memberSince when no inviter', () => {
    const view = toPublicInviteView(
      { ...invite, note: null, vouch: null },
      null,
      0,
      now,
    );
    expect(view.note).toBeNull();
    expect(view.vouch).toBeNull();
    expect(view.inviter.avatarUrl).toBeNull();
    expect(view.inviter).not.toHaveProperty('memberSince');
  });
});

describe('InvitesService.resolveInvite', () => {
  let service: InvitesService;
  let repo: { findOne: jest.Mock };
  let users: {
    findByIdWithProfile: jest.Mock;
    countActiveMembers: jest.Mock;
  };

  beforeEach(async () => {
    repo = { findOne: jest.fn() };
    users = {
      findByIdWithProfile: jest.fn(),
      countActiveMembers: jest.fn().mockResolvedValue(247),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: repo },
        { provide: UsersService, useValue: users },
        { provide: DataSource, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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
      expiresAt: new Date('2026-07-07T10:42:00.000Z'),
    });
    users.findByIdWithProfile.mockResolvedValue({
      activatedAt: new Date('2024-03-01T00:00:00.000Z'),
      createdAt: new Date('2024-02-01T00:00:00.000Z'),
      profile: {
        slug: 'ines',
        firstName: 'Inês',
        lastName: 'Tavares',
        avatarUrl: null,
      },
    });

    const view = await service.resolveInvite('QP-7F3K-2026');

    expect(users.findByIdWithProfile).toHaveBeenCalledWith('inviter');
    expect(view.status).toBe('valid');
    expect(view.memberCount).toBe(247);
    expect(view.inviter.slug).toBe('ines');
    expect(view.note).toBe('hello');
  });
});

describe('InvitesService.createInvite', () => {
  let service: InvitesService;
  let invitesRepo: { exists: jest.Mock };
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
    invitesRepo = { exists: jest.fn().mockResolvedValue(false) };
    // Default: no per-user override, so the quota check falls back to config.
    userRepo = { findOne: jest.fn().mockResolvedValue(null) };
    manager = {
      getRepository: jest.fn(() => userRepo),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((_entity, v) => v),
      save: jest.fn(async (v) => v),
    };
    config = { get: jest.fn(() => quota) };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: invitesRepo },
        { provide: UsersService, useValue: { findById: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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
    invitesRepo.exists
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
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

  it('rejects with 403 when the monthly quota is exhausted', async () => {
    await build(1);
    manager.count.mockResolvedValue(1); // already used this month's allowance

    await expect(
      service.createInvite('inviter', { note: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.save).not.toHaveBeenCalled();
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
    const where = manager.count.mock.calls[0][1].where;
    expect(where.inviterId).toBe('inviter');
    // MoreThanOrEqual(monthStart) — assert the boundary is the 1st at 00:00 UTC.
    const boundary: Date = where.createdAt.value;
    expect(boundary.getUTCDate()).toBe(1);
    expect(boundary.getUTCHours()).toBe(0);
    expect(boundary.getUTCMinutes()).toBe(0);
  });
});

describe('InvitesService.listMyInvites', () => {
  let service: InvitesService;
  let repo: { find: jest.Mock };

  beforeEach(async () => {
    repo = { find: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: getRepositoryToken(Invite), useValue: repo },
        { provide: UsersService, useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['code', 'createdAt', 'email', 'expiresAt', 'note', 'status', 'vouch'].sort(),
    );
    expect(rows[0]).not.toHaveProperty('id');
    expect(rows[0]).not.toHaveProperty('acceptedBy');
    expect(rows[0].expiresAt).toBe('2026-07-12T00:00:00.000Z');
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
    expect(rows[0].status).toBe('expired');
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
        { provide: ConfigService, useValue: { get: jest.fn(() => 1) } },
      ],
    }).compile();
    service = module.get(InvitesService);
  });

  describe('validateInviteForSignup', () => {
    const makeManager = (invite: any) =>
      ({
        getRepository: () => ({
          findOne: jest.fn().mockResolvedValue(invite),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      }) as any;

    it('returns inviteId + inviterId for a valid pending invite', async () => {
      usersService.findById = jest
        .fn()
        .mockResolvedValue({ id: 'inviter-1', status: UserStatus.Active });
      const manager = makeManager({
        id: 'inv-1',
        inviterId: 'inviter-1',
        status: InviteStatus.Pending,
        email: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.validateInviteForSignup(manager, 'CODE', 'a@b.c'),
      ).resolves.toEqual({ inviteId: 'inv-1', inviterId: 'inviter-1' });
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
        .mockResolvedValue({ id: 'inviter-1', status: UserStatus.Pending });
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
      } as any;
      await expect(
        service.claimInvite(manager, 'inv-1', 'new-user'),
      ).rejects.toBeInstanceOf(SignupRejectedError);
    });

    it('resolves when exactly one row is claimed', async () => {
      const update = jest.fn().mockResolvedValue({ affected: 1 });
      const manager = { getRepository: () => ({ update }) } as any;
      await expect(
        service.claimInvite(manager, 'inv-1', 'new-user'),
      ).resolves.toBeUndefined();
      expect(update).toHaveBeenCalledWith(
        { id: 'inv-1', status: InviteStatus.Pending },
        {
          status: InviteStatus.Accepted,
          acceptedBy: 'new-user',
          usedAt: expect.any(Date),
        },
      );
    });
  });
});
