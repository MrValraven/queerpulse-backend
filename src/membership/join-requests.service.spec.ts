import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError } from 'typeorm';
import { CreateMembershipJoinRequestDto } from './dto/create-join-request.dto';
import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from './entities/join-request.entity';
import { InvitesService } from './invites.service';
import { JoinRequestsService } from './join-requests.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';

const uniqueViolation = () =>
  new QueryFailedError('insert', [], {
    code: '23505',
  } as unknown as Error);

// The deadline a reissued approval invite comes back with. Seven days out from
// whenever the suite runs, so `resolveInviteStatus` reads it as `valid`.
const REISSUED_INVITE_EXPIRES_AT = new Date(
  Date.now() + 7 * 24 * 60 * 60 * 1000,
);

const dto = (overrides: Partial<CreateMembershipJoinRequestDto> = {}) =>
  ({
    name: 'Sam Costa',
    email: 'sam@example.com',
    city: 'Lisbon',
    message: 'let me in',
    ageAttested: true,
    termsVersion: '2.4',
    ...overrides,
  }) as CreateMembershipJoinRequestDto;

describe('JoinRequestsService', () => {
  let service: JoinRequestsService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    take: jest.Mock;
    limit: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    getOne: jest.Mock;
    getMany: jest.Mock;
    getRawMany: jest.Mock;
  };
  let txRepo: { findOne: jest.Mock; update: jest.Mock };
  let invites: {
    createInviteForApproval: jest.Mock;
    startApprovalRedemptionWindow: jest.Mock;
    reissueApprovalInvite: jest.Mock;
  };
  let inviteRepo: { find: jest.Mock; findOne: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let profileRepo: { find: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };
  let manager: { getRepository: jest.Mock };
  let platformSettings: { get: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    txRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((row: PlatformJoinRequest) =>
        Promise.resolve({
          ...row,
          id: 'r1',
          createdAt: new Date('2026-07-18T00:00:00.000Z'),
        }),
      ),
      create: jest.fn((value: Partial<PlatformJoinRequest>) => value),
      // The `approval_seen_at` latch and the refresh counter's conditional
      // claim both go through this. Winning by default: a test that wants the
      // losing branch overrides it.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qb),
    };
    invites = {
      createInviteForApproval: jest
        .fn()
        .mockResolvedValue({ id: 'inv-1', code: 'QP-ABCD-EFGH' }),
      // PRD-02: the redemption window the applicant's first status read starts.
      startApprovalRedemptionWindow: jest
        .fn()
        .mockResolvedValue(new Date('2026-07-28T00:00:00.000Z')),
      // The deadline is RELATIVE to now on purpose: `resolveInviteStatus`
      // compares it against the real clock, so a hardcoded calendar date turns
      // this fixture into a time bomb that silently reports the reissued
      // invite as `expired` once that date passes (it did).
      reissueApprovalInvite: jest.fn().mockResolvedValue({
        id: 'inv-1',
        code: 'QP-ABCD-EFGH',
        status: 'pending',
        expiresAt: REISSUED_INVITE_EXPIRES_AT,
      }),
    };
    inviteRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    // No reference member matched by default: `submit()` skips this query
    // entirely unless a test's dto supplies `mutualMemberEmail`.
    userRepo = { findOne: jest.fn().mockResolvedValue(null) };
    profileRepo = { find: jest.fn().mockResolvedValue([]) };
    manager = { getRepository: jest.fn(() => txRepo) };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          (
            runInTransaction: (
              entityManager: typeof manager,
            ) => Promise<unknown>,
          ) => runInTransaction(manager),
        ),
      // Routed by entity, mirroring how the service itself picks a repo per
      // call: `list()` reaches for Invite and Profile, `submit()` reaches
      // for User only when a mutualMemberEmail was supplied.
      getRepository: jest.fn((entity: unknown) => {
        if (entity === User) return userRepo;
        if (entity === Profile) return profileRepo;
        return inviteRepo;
      }),
    };
    // Join-request kill switch — on by default, so submission is unaffected
    // unless a test explicitly turns it off.
    platformSettings = {
      get: jest.fn().mockResolvedValue({
        joinRequestsEnabled: true,
        registrationClosedMessage: null,
      }),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JoinRequestsService,
        { provide: getRepositoryToken(PlatformJoinRequest), useValue: repo },
        { provide: InvitesService, useValue: invites },
        { provide: DataSource, useValue: dataSource },
        { provide: PlatformSettingsService, useValue: platformSettings },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(JoinRequestsService);
  });

  describe('submit', () => {
    it('persists a pending request and returns only { id, status, createdAt, statusToken }', async () => {
      const res = await service.submit(dto());
      expect(repo.save).toHaveBeenCalled();
      expect(res.status).toBe(PlatformJoinRequestStatus.Pending);
      expect(Object.keys(res).sort()).toEqual([
        'createdAt',
        'id',
        'status',
        'statusToken',
      ]);
    });

    it('mints a url-safe status token and persists only its sha256 hash', async () => {
      const res = await service.submit(dto());
      // base64url of 32 random bytes: 43 characters, no padding, no `+` or `/`.
      expect(res.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The row gets the HASH; the plaintext exists only in the response.
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          statusTokenHash: createHash('sha256')
            .update(res.statusToken)
            .digest('hex'),
        }),
      );
      expect(repo.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ statusTokenHash: res.statusToken }),
      );
    });

    it('mints a different status token for every submission', async () => {
      const first = await service.submit(dto());
      const second = await service.submit(dto({ email: 'other@example.com' }));
      expect(first.statusToken).not.toBe(second.statusToken);
    });

    it('normalises the email to lowercase and trims name/city', async () => {
      await service.submit(
        dto({ email: '  SAM@Example.COM ', name: ' Sam ', city: ' Porto ' }),
      );
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'sam@example.com',
          name: 'Sam',
          city: 'Porto',
        }),
      );
    });

    it('stores an empty/whitespace city as null', async () => {
      await service.submit(dto({ city: '   ' }));
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ city: null }),
      );
    });

    it('stamps ageAttestedAt and the terms version', async () => {
      await service.submit(dto({ termsVersion: '3.0' }));
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ageAttestedAt: expect.any(Date) as unknown,
          termsVersion: '3.0',
        }),
      );
    });

    it('rejects a duplicate open request for the same email (pre-check) with 409', async () => {
      qb.getOne.mockResolvedValue({ id: 'existing' });
      await expect(service.submit(dto())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('matches the open-request pre-check case-insensitively', async () => {
      await service.submit(dto({ email: 'SAM@EXAMPLE.COM' }));
      expect(qb.where).toHaveBeenCalledWith('lower(jr.email) = :email', {
        email: 'sam@example.com',
      });
    });

    it('maps a 23505 on insert to 409 (partial unique index backstop)', async () => {
      qb.getOne.mockResolvedValue(null);
      repo.save.mockRejectedValue(uniqueViolation());
      await expect(service.submit(dto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('tells the join-request rota that an application landed', async () => {
      await service.submit(dto());
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.InviteRequests,
        'r1',
      );
    });

    it('tells nobody when the submission is refused', async () => {
      platformSettings.get.mockResolvedValue({
        joinRequestsEnabled: false,
        registrationClosedMessage: null,
      });
      await expect(service.submit(dto())).rejects.toThrow();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    describe('18+ gate', () => {
      const dobYearsAgo = (years: number): string => {
        const d = new Date();
        d.setUTCFullYear(d.getUTCFullYear() - years);
        return d.toISOString().slice(0, 10);
      };

      it('rejects a supplied DOB under 18 with 403 UNDER_18', async () => {
        await expect(
          service.submit(dto({ dateOfBirth: dobYearsAgo(17) })),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(repo.save).not.toHaveBeenCalled();
      });

      it('exposes the UNDER_18 code in the response body', async () => {
        await expect(
          service.submit(dto({ dateOfBirth: dobYearsAgo(10) })),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'UNDER_18' }) as unknown,
        });
      });

      it('rejects a future DOB', async () => {
        await expect(
          service.submit(dto({ dateOfBirth: dobYearsAgo(-5) })),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('accepts a DOB of exactly 18', async () => {
        await expect(
          service.submit(dto({ dateOfBirth: dobYearsAgo(18) })),
        ).resolves.toEqual(
          expect.objectContaining({
            status: PlatformJoinRequestStatus.Pending,
          }),
        );
      });

      it('accepts a submission with no DOB at all (attestation is the gate)', async () => {
        await expect(service.submit(dto())).resolves.toEqual(
          expect.objectContaining({
            status: PlatformJoinRequestStatus.Pending,
          }),
        );
      });
    });

    describe('reapplication cooldown', () => {
      it('rejects a resubmission within 30 days of a decline, with REAPPLICATION_COOLDOWN', async () => {
        qb.getOne.mockResolvedValue({
          reviewedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        });
        await expect(service.submit(dto())).rejects.toMatchObject({
          status: 403,
          response: { code: 'REAPPLICATION_COOLDOWN' },
        });
        expect(repo.save).not.toHaveBeenCalled();
      });

      it('allows a resubmission more than 30 days after a decline', async () => {
        // submit()'s first createQueryBuilder().getOne() call is the cooldown
        // lookup (this describe block's concern), and the second is the
        // pre-existing open-request pre-check — queued in that call order.
        qb.getOne
          .mockResolvedValueOnce({
            reviewedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          })
          .mockResolvedValueOnce(null);
        await expect(service.submit(dto())).resolves.toEqual(
          expect.objectContaining({
            status: PlatformJoinRequestStatus.Pending,
          }),
        );
      });
    });

    describe('reference resolution', () => {
      it('resolves the reference to an active member by email', async () => {
        userRepo.findOne.mockResolvedValue({ id: 'u1' });
        await service.submit(dto({ mutualMemberEmail: 'friend@example.com' }));
        expect(userRepo.findOne).toHaveBeenCalledWith({
          where: { email: 'friend@example.com', status: 'active' },
        });
        expect(repo.create).toHaveBeenCalledWith(
          expect.objectContaining({ referenceUserId: 'u1' }),
        );
      });

      it('leaves referenceUserId null when the email matches no active member', async () => {
        userRepo.findOne.mockResolvedValue(null);
        await service.submit(dto({ mutualMemberEmail: 'nobody@example.com' }));
        expect(repo.create).toHaveBeenCalledWith(
          expect.objectContaining({ referenceUserId: null }),
        );
      });

      it('stores nulls when no reference was supplied', async () => {
        await service.submit(dto());
        expect(userRepo.findOne).not.toHaveBeenCalled();
        expect(repo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            mutualMemberEmail: null,
            referenceUserId: null,
          }),
        );
      });
    });

    describe('join-requests kill switch', () => {
      it('rejects a submission with JOIN_REQUESTS_CLOSED when join requests are off', async () => {
        platformSettings.get.mockResolvedValue({
          joinRequestsEnabled: false,
          registrationClosedMessage: 'Paused while we clear out spam.',
        });

        await expect(service.submit(dto())).rejects.toMatchObject({
          status: 403,
          response: {
            code: 'JOIN_REQUESTS_CLOSED',
            message: 'Paused while we clear out spam.',
          },
        });
      });

      it('checks the switch before touching the database', async () => {
        // A spam flood is exactly when you do not want every rejected
        // submission to still cost a duplicate-check query.
        platformSettings.get.mockResolvedValue({
          joinRequestsEnabled: false,
          registrationClosedMessage: null,
        });

        // Assert the fallback copy itself, not just "it threw": with no admin
        // message set, this default string is the entire user-facing
        // explanation, and nothing else in the suite covers it.
        await expect(service.submit(dto())).rejects.toMatchObject({
          status: 403,
          response: {
            code: 'JOIN_REQUESTS_CLOSED',
            message: 'We are not accepting new invite requests right now',
          },
        });

        expect(repo.createQueryBuilder).not.toHaveBeenCalled();
        expect(repo.save).not.toHaveBeenCalled();
      });

      it('falls back to the default copy when the admin message is an empty string', async () => {
        // Clearing the message textarea sends '' — `??` would not catch it and
        // the applicant would get a blank rejection.
        platformSettings.get.mockResolvedValue({
          joinRequestsEnabled: false,
          registrationClosedMessage: '',
        });

        await expect(service.submit(dto())).rejects.toMatchObject({
          response: {
            code: 'JOIN_REQUESTS_CLOSED',
            message: 'We are not accepting new invite requests right now',
          },
        });
      });
    });
  });

  describe('getPublicStatus', () => {
    const hashOf = (token: string) =>
      createHash('sha256').update(token).digest('hex');

    const storedRequest = (overrides: Partial<PlatformJoinRequest> = {}) =>
      ({
        id: 'r1',
        status: PlatformJoinRequestStatus.Pending,
        createdAt: new Date('2026-07-18T00:00:00.000Z'),
        reviewedAt: null,
        declineReason: null,
        inviteId: null,
        approvalSeenAt: null,
        inviteRefreshCount: 0,
        ...overrides,
      }) as PlatformJoinRequest;

    it('looks the request up by the HASH of the token, never the plaintext', async () => {
      repo.findOne.mockResolvedValue(storedRequest());
      await service.getPublicStatus('a-token');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { statusTokenHash: hashOf('a-token') },
      });
    });

    it('returns null for a token that resolves to nothing', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getPublicStatus('nope')).resolves.toBeNull();
    });

    it('reports a pending request as under_review with no decision fields', async () => {
      repo.findOne.mockResolvedValue(storedRequest());
      await expect(service.getPublicStatus('t')).resolves.toEqual({
        status: 'under_review',
        submittedAt: '2026-07-18T00:00:00.000Z',
        decidedAt: null,
        declineReason: null,
        inviteCode: null,
        inviteStatus: null,
        inviteExpiresAt: null,
      });
    });

    it('reports a WAITLISTED request as under_review, hiding even its reviewedAt', async () => {
      repo.findOne.mockResolvedValue(
        storedRequest({
          status: PlatformJoinRequestStatus.Waitlisted,
          reviewedAt: new Date('2026-07-20T00:00:00.000Z'),
        }),
      );
      await expect(service.getPublicStatus('t')).resolves.toMatchObject({
        status: 'under_review',
        decidedAt: null,
      });
    });

    it('returns the decline reason and decision time on a decline', async () => {
      repo.findOne.mockResolvedValue(
        storedRequest({
          status: PlatformJoinRequestStatus.Declined,
          reviewedAt: new Date('2026-07-20T00:00:00.000Z'),
          declineReason: 'implausible',
        }),
      );
      await expect(service.getPublicStatus('t')).resolves.toEqual({
        status: 'declined',
        submittedAt: '2026-07-18T00:00:00.000Z',
        decidedAt: '2026-07-20T00:00:00.000Z',
        declineReason: 'implausible',
        inviteCode: null,
        inviteStatus: null,
        inviteExpiresAt: null,
      });
    });

    it('returns the invite code on an approval while the invite is still redeemable', async () => {
      repo.findOne.mockResolvedValue(
        storedRequest({
          status: PlatformJoinRequestStatus.Approved,
          reviewedAt: new Date('2026-07-20T00:00:00.000Z'),
          inviteId: 'inv-1',
        }),
      );
      inviteRepo.findOne.mockResolvedValue({
        id: 'inv-1',
        code: 'QP-ABCD-EFGH',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await expect(service.getPublicStatus('t')).resolves.toMatchObject({
        status: 'approved',
        inviteCode: 'QP-ABCD-EFGH',
      });
    });

    it('withholds the invite code once the invite has expired', async () => {
      repo.findOne.mockResolvedValue(
        storedRequest({
          status: PlatformJoinRequestStatus.Approved,
          reviewedAt: new Date('2026-07-20T00:00:00.000Z'),
          inviteId: 'inv-1',
        }),
      );
      inviteRepo.findOne.mockResolvedValue({
        id: 'inv-1',
        code: 'QP-ABCD-EFGH',
        status: 'pending',
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      await expect(service.getPublicStatus('t')).resolves.toMatchObject({
        status: 'approved',
        inviteCode: null,
      });
    });

    it('never leaks the applicant message, email, or reviewer', async () => {
      repo.findOne.mockResolvedValue(
        storedRequest({
          email: 'sam@example.com',
          message: 'let me in',
          reviewedBy: 'admin-1',
        }),
      );
      const view = await service.getPublicStatus('t');
      expect(Object.keys(view ?? {}).sort()).toEqual([
        'decidedAt',
        'declineReason',
        'inviteCode',
        'inviteExpiresAt',
        'inviteStatus',
        'status',
        'submittedAt',
      ]);
    });

    // PRD-02. Approval mints an invite nothing delivers, so this read is the
    // only moment the applicant learns it exists, and therefore the only
    // honest moment for its clock to start.
    describe('the redemption window (PRD-02)', () => {
      const approvedRequest = (overrides: Partial<PlatformJoinRequest> = {}) =>
        storedRequest({
          status: PlatformJoinRequestStatus.Approved,
          reviewedAt: new Date('2026-07-20T00:00:00.000Z'),
          inviteId: 'inv-1',
          ...overrides,
        });

      const liveInvite = () => ({
        id: 'inv-1',
        code: 'QP-ABCD-EFGH',
        status: 'pending',
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      });

      it('starts the window on the FIRST read that hands over the code', async () => {
        repo.findOne.mockResolvedValue(approvedRequest());
        inviteRepo.findOne.mockResolvedValue(liveInvite());

        const view = await service.getPublicStatus('t');

        expect(invites.startApprovalRedemptionWindow).toHaveBeenCalledWith(
          'inv-1',
          expect.any(Date),
        );
        // The deadline reported is the one just set, never the shelf date.
        expect(view?.inviteExpiresAt).toBe('2026-07-28T00:00:00.000Z');
      });

      it('latches on approval_seen_at IS NULL so two reads cannot both move it', async () => {
        repo.findOne.mockResolvedValue(approvedRequest());
        inviteRepo.findOne.mockResolvedValue(liveInvite());

        await service.getPublicStatus('t');

        const [criteria, patch] = repo.update.mock.calls[0] as [
          { id: string; approvalSeenAt: { type: string } },
          { approvalSeenAt: Date },
        ];
        expect(criteria.id).toBe('r1');
        // A FindOperator, so the UPDATE carries `approval_seen_at IS NULL`:
        // of two concurrent reads exactly one can win the latch.
        expect(criteria.approvalSeenAt.type).toBe('isNull');
        expect(patch.approvalSeenAt).toBeInstanceOf(Date);
      });

      it('leaves the deadline alone on every later read', async () => {
        repo.findOne.mockResolvedValue(
          approvedRequest({
            approvalSeenAt: new Date('2026-07-21T00:00:00.000Z'),
          }),
        );
        inviteRepo.findOne.mockResolvedValue(liveInvite());

        await service.getPublicStatus('t');

        expect(invites.startApprovalRedemptionWindow).not.toHaveBeenCalled();
        expect(repo.update).not.toHaveBeenCalled();
      });

      it("reports the winner's deadline when a concurrent read took the latch", async () => {
        repo.findOne.mockResolvedValue(approvedRequest());
        repo.update.mockResolvedValue({ affected: 0 });
        inviteRepo.findOne
          .mockResolvedValueOnce(liveInvite())
          .mockResolvedValueOnce({
            ...liveInvite(),
            expiresAt: new Date('2026-07-28T00:00:00.000Z'),
          });

        const view = await service.getPublicStatus('t');

        expect(invites.startApprovalRedemptionWindow).not.toHaveBeenCalled();
        expect(view?.inviteExpiresAt).toBe('2026-07-28T00:00:00.000Z');
      });

      it('never starts a window on an invite that is already spent', async () => {
        repo.findOne.mockResolvedValue(approvedRequest());
        inviteRepo.findOne.mockResolvedValue({
          ...liveInvite(),
          status: 'accepted',
        });

        const view = await service.getPublicStatus('t');

        expect(invites.startApprovalRedemptionWindow).not.toHaveBeenCalled();
        // The reason the code is missing now reaches the applicant, so the
        // page can stop collapsing used/revoked/expired into one dead end.
        expect(view?.inviteStatus).toBe('used');
        expect(view?.inviteCode).toBeNull();
      });
    });
  });

  // PRD-02. The applicant reviving their own lapsed approval invite, holding
  // nothing but the status token.
  describe('refreshApprovalInvite', () => {
    const lapsedRequest = (overrides: Partial<PlatformJoinRequest> = {}) =>
      ({
        id: 'r1',
        status: PlatformJoinRequestStatus.Approved,
        createdAt: new Date('2026-07-18T00:00:00.000Z'),
        reviewedAt: new Date('2026-07-20T00:00:00.000Z'),
        declineReason: null,
        inviteId: 'inv-1',
        approvalSeenAt: new Date('2026-07-21T00:00:00.000Z'),
        inviteRefreshCount: 0,
        ...overrides,
      }) as PlatformJoinRequest;

    const lapsedInvite = (status = 'pending') => ({
      id: 'inv-1',
      code: 'QP-ABCD-EFGH',
      status,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    it('returns null for a token that resolves to nothing, exactly as the read does', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.refreshApprovalInvite('nope')).resolves.toBeNull();
    });

    it('revives a lapsed invite and reports the new deadline', async () => {
      repo.findOne.mockResolvedValue(lapsedRequest());
      inviteRepo.findOne.mockResolvedValue(lapsedInvite());

      const view = await service.refreshApprovalInvite('t');

      expect(invites.reissueApprovalInvite).toHaveBeenCalledWith('inv-1');
      expect(view).toMatchObject({
        status: 'approved',
        inviteCode: 'QP-ABCD-EFGH',
        inviteStatus: 'valid',
        inviteExpiresAt: REISSUED_INVITE_EXPIRES_AT.toISOString(),
      });
    });

    it('spends a refresh slot with a conditional claim on the count it read', async () => {
      repo.findOne.mockResolvedValue(lapsedRequest({ inviteRefreshCount: 1 }));
      inviteRepo.findOne.mockResolvedValue(lapsedInvite());

      await service.refreshApprovalInvite('t');

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'r1', inviteRefreshCount: 1 },
        { inviteRefreshCount: 2 },
      );
    });

    it('refuses once the per-request cap is spent', async () => {
      repo.findOne.mockResolvedValue(lapsedRequest({ inviteRefreshCount: 3 }));
      inviteRepo.findOne.mockResolvedValue(lapsedInvite());

      await expect(service.refreshApprovalInvite('t')).rejects.toMatchObject({
        response: { code: 'INVITE_REFRESH_LIMIT' },
      });
      expect(invites.reissueApprovalInvite).not.toHaveBeenCalled();
    });

    it('refuses to re-open an invite an account was already created with', async () => {
      repo.findOne.mockResolvedValue(lapsedRequest());
      inviteRepo.findOne.mockResolvedValue(lapsedInvite('accepted'));

      await expect(service.refreshApprovalInvite('t')).rejects.toMatchObject({
        response: { code: 'INVITE_ALREADY_USED' },
      });
      expect(invites.reissueApprovalInvite).not.toHaveBeenCalled();
    });

    it('refuses to undo a moderator revoke', async () => {
      repo.findOne.mockResolvedValue(lapsedRequest());
      inviteRepo.findOne.mockResolvedValue(lapsedInvite('revoked'));

      await expect(service.refreshApprovalInvite('t')).rejects.toMatchObject({
        response: { code: 'INVITE_REVOKED' },
      });
    });

    it('answers a still-valid invite with the live view rather than an error', async () => {
      repo.findOne.mockResolvedValue(lapsedRequest());
      inviteRepo.findOne.mockResolvedValue({
        ...lapsedInvite(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const view = await service.refreshApprovalInvite('t');

      expect(view).toMatchObject({ inviteCode: 'QP-ABCD-EFGH' });
      expect(invites.reissueApprovalInvite).not.toHaveBeenCalled();
    });

    it('refuses a request that never minted an invite', async () => {
      repo.findOne.mockResolvedValue(lapsedRequest({ inviteId: null }));

      await expect(service.refreshApprovalInvite('t')).rejects.toMatchObject({
        response: { code: 'INVITE_REFRESH_UNAVAILABLE' },
      });
    });
  });

  // PRD-14. The lost-token path. Reachable ONLY behind a proof of address
  // ownership the caller supplies; there is no route into this from a typed
  // email, and there must never be one.
  describe('recoverStatusTokenForVerifiedEmail', () => {
    it('returns null when the address has never applied', async () => {
      qb.getOne.mockResolvedValue(null);
      await expect(
        service.recoverStatusTokenForVerifiedEmail('nobody@example.com'),
      ).resolves.toBeNull();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('matches the address case-insensitively, as the submit path stores it', async () => {
      qb.getOne.mockResolvedValue({ id: 'r1' });
      await service.recoverStatusTokenForVerifiedEmail('  Sam@Example.COM ');
      expect(qb.where).toHaveBeenCalledWith('lower(jr.email) = :email', {
        email: 'sam@example.com',
      });
    });

    it('takes the most recent request, whatever its outcome', async () => {
      qb.getOne.mockResolvedValue({ id: 'r1' });
      await service.recoverStatusTokenForVerifiedEmail('sam@example.com');
      expect(qb.orderBy).toHaveBeenCalledWith('jr.createdAt', 'DESC');
      // No status narrowing: a declined applicant is entitled to read their
      // own decline.
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('stores only the HASH of the new token and returns the plaintext once', async () => {
      qb.getOne.mockResolvedValue({ id: 'r1' });

      const token =
        await service.recoverStatusTokenForVerifiedEmail('sam@example.com');

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'r1' },
        {
          statusTokenHash: createHash('sha256')
            .update(token as string)
            .digest('hex'),
        },
      );
    });

    it('ROTATES, so the token it replaces stops working', async () => {
      qb.getOne.mockResolvedValue({ id: 'r1' });

      const first = await service.recoverStatusTokenForVerifiedEmail('a@b.co');
      const second = await service.recoverStatusTokenForVerifiedEmail('a@b.co');

      expect(first).not.toBe(second);
      const [, firstWrite] = repo.update.mock.calls[0] as [unknown, unknown];
      const [, secondWrite] = repo.update.mock.calls[1] as [unknown, unknown];
      expect(firstWrite).not.toEqual(secondWrite);
    });
  });

  describe('list', () => {
    const row = (overrides = {}) =>
      ({
        id: 'r1',
        name: 'Sam',
        email: 'sam@example.com',
        city: null,
        message: 'hi',
        source: null,
        mutualMemberEmail: null,
        referenceUserId: null,
        status: PlatformJoinRequestStatus.Pending,
        ageAttestedAt: new Date(),
        termsVersion: '2.4',
        reviewedBy: null,
        reviewedAt: null,
        inviteId: null,
        createdAt: new Date(),
        ...overrides,
      }) as PlatformJoinRequest;

    it('returns inviteCode null for rows with no invite, without querying invites', async () => {
      qb.getMany.mockResolvedValue([row()]);
      const [view] = await service.list();
      expect(view!.inviteCode).toBeNull();
      expect(inviteRepo.find).not.toHaveBeenCalled();
    });

    it('resolves invite codes in ONE query for the whole page', async () => {
      qb.getMany.mockResolvedValue([
        row({ id: 'a', inviteId: 'inv-1' }),
        row({ id: 'b', inviteId: 'inv-2' }),
        row({ id: 'c' }),
      ]);
      inviteRepo.find.mockResolvedValue([
        { id: 'inv-1', code: 'QP-AAAA-BBBB' },
        { id: 'inv-2', code: 'QP-CCCC-DDDD' },
      ]);
      const views = await service.list();
      expect(inviteRepo.find).toHaveBeenCalledTimes(1);
      expect(views.map((v) => v.inviteCode)).toEqual([
        'QP-AAAA-BBBB',
        'QP-CCCC-DDDD',
        null,
      ]);
    });

    it('passes the status filter through', async () => {
      await service.list(PlatformJoinRequestStatus.Approved);
      expect(qb.andWhere).toHaveBeenCalledWith('jr.status = :status', {
        status: PlatformJoinRequestStatus.Approved,
      });
    });

    it('includes a disposable_email flag for a throwaway domain', async () => {
      qb.getMany.mockResolvedValue([row({ email: 'x@mailinator.com' })]);
      const [view] = await service.list();
      expect(view!.flags).toContain('disposable_email');
    });

    it('reports how many times this email was previously declined', async () => {
      qb.getMany.mockResolvedValue([row({ email: 'sam@example.com' })]);
      repo.createQueryBuilder = jest.fn(() => ({
        ...qb,
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ email: 'sam@example.com', count: '2' }]),
      }));
      const [view] = await service.list();
      expect(view!.priorDeclineCount).toBe(2);
    });

    it('filters by source when provided', async () => {
      await service.list(undefined, { source: 'homepage_hero' });
      expect(qb.andWhere).toHaveBeenCalledWith('jr.source = :source', {
        source: 'homepage_hero',
      });
    });

    it('applies a cursor as createdAt > cursor when sorting oldest-first', async () => {
      await service.list(undefined, {
        cursor: '2026-08-01T00:00:00.000Z',
        sort: 'oldest',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('jr.createdAt > :cursor', {
        cursor: '2026-08-01T00:00:00.000Z',
      });
    });

    it('applies a cursor as createdAt < cursor when sorting newest-first', async () => {
      await service.list(undefined, {
        cursor: '2026-08-01T00:00:00.000Z',
        sort: 'newest',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('jr.createdAt < :cursor', {
        cursor: '2026-08-01T00:00:00.000Z',
      });
    });

    it('respects a custom limit, capped by the DTO at 100', async () => {
      await service.list(undefined, { limit: 10 });
      expect(qb.take).toHaveBeenCalledWith(10);
    });
  });

  describe('review', () => {
    const pendingRow = () => ({
      id: 'r1',
      name: 'Sam',
      email: 'sam@example.com',
      status: PlatformJoinRequestStatus.Pending,
    });

    it('approving mints an invite bound to the email, on the SAME manager', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      const result = await service.review(
        'r1',
        'admin-1',
        PlatformJoinRequestStatus.Approved,
      );

      expect(invites.createInviteForApproval).toHaveBeenCalledWith(
        manager,
        'admin-1',
        'sam@example.com',
      );
      expect(result.inviteCode).toBe('QP-ABCD-EFGH');
      expect(result.status).toBe(PlatformJoinRequestStatus.Approved);
      expect(result.reviewedBy).toBe('admin-1');
    });

    it('records the approving admin as the inviter', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      await service.review('r1', 'admin-7', PlatformJoinRequestStatus.Approved);
      expect(invites.createInviteForApproval).toHaveBeenCalledWith(
        expect.anything(),
        'admin-7',
        expect.any(String),
      );
    });

    it('writes invite_id in the same UPDATE as the status flip', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      await service.review('r1', 'admin-1', PlatformJoinRequestStatus.Approved);
      expect(txRepo.update).toHaveBeenCalledWith(
        {
          id: 'r1',
          status: In([
            PlatformJoinRequestStatus.Pending,
            PlatformJoinRequestStatus.Waitlisted,
          ]),
        },
        expect.objectContaining({
          status: PlatformJoinRequestStatus.Approved,
          reviewedBy: 'admin-1',
          reviewedAt: expect.any(Date) as unknown,
          inviteId: 'inv-1',
        }),
      );
    });

    it('declines without minting an invite', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      const result = await service.review(
        'r1',
        'admin-1',
        PlatformJoinRequestStatus.Declined,
        'spam_pattern',
      );
      expect(invites.createInviteForApproval).not.toHaveBeenCalled();
      expect(result.inviteCode).toBeNull();
      expect(txRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inviteId: null }),
      );
    });

    // The reason is enforced in the SERVICE, not just by the frontend always
    // sending one: a decline with no recorded reason leaves the applicant with
    // an unexplainable outcome and the reviewer with nothing to appeal against.
    it('refuses a decline with no reason', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      await expect(
        service.review('r1', 'admin-1', PlatformJoinRequestStatus.Declined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txRepo.update).not.toHaveBeenCalled();
    });

    it('refuses a decline whose reason is only whitespace', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      await expect(
        service.review(
          'r1',
          'admin-1',
          PlatformJoinRequestStatus.Declined,
          '   ',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txRepo.update).not.toHaveBeenCalled();
    });

    it('404s on an unknown request', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await expect(
        service.review('nope', 'admin-1', PlatformJoinRequestStatus.Approved),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an already-reviewed request with 409', async () => {
      txRepo.findOne.mockResolvedValue({
        ...pendingRow(),
        status: PlatformJoinRequestStatus.Approved,
      });
      await expect(
        service.review('r1', 'admin-1', PlatformJoinRequestStatus.Approved),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(invites.createInviteForApproval).not.toHaveBeenCalled();
    });

    it('rejects when a concurrent reviewer already claimed it (affected 0)', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      txRepo.update.mockResolvedValue({ affected: 0 });
      // The mint already ran, but the throw rolls the whole transaction back,
      // so the orphaned invite never commits.
      await expect(
        service.review('r1', 'admin-1', PlatformJoinRequestStatus.Approved),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('moves a pending request to waitlisted without minting an invite', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      const result = await service.review(
        'r1',
        'admin-1',
        PlatformJoinRequestStatus.Waitlisted,
      );
      expect(invites.createInviteForApproval).not.toHaveBeenCalled();
      expect(result.status).toBe(PlatformJoinRequestStatus.Waitlisted);
      expect(txRepo.update).toHaveBeenCalledWith(
        {
          id: 'r1',
          status: In([
            PlatformJoinRequestStatus.Pending,
            PlatformJoinRequestStatus.Waitlisted,
          ]),
        },
        expect.objectContaining({
          status: PlatformJoinRequestStatus.Waitlisted,
        }),
      );
    });

    it('allows moving a waitlisted request on to approved', async () => {
      txRepo.findOne.mockResolvedValue({
        ...pendingRow(),
        status: PlatformJoinRequestStatus.Waitlisted,
      });
      const result = await service.review(
        'r1',
        'admin-1',
        PlatformJoinRequestStatus.Approved,
      );
      expect(result.status).toBe(PlatformJoinRequestStatus.Approved);
      expect(invites.createInviteForApproval).toHaveBeenCalled();
    });

    it('still rejects reviewing an already-approved request with 409', async () => {
      txRepo.findOne.mockResolvedValue({
        ...pendingRow(),
        status: PlatformJoinRequestStatus.Approved,
      });
      await expect(
        service.review('r1', 'admin-1', PlatformJoinRequestStatus.Waitlisted),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('requires a decline reason', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      await expect(
        service.review('r1', 'admin-1', PlatformJoinRequestStatus.Declined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txRepo.update).not.toHaveBeenCalled();
    });

    it('records the decline reason on the update', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      await service.review(
        'r1',
        'admin-1',
        PlatformJoinRequestStatus.Declined,
        'spam_pattern',
      );
      expect(txRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ declineReason: 'spam_pattern' }),
      );
    });
  });

  describe('bulkReview', () => {
    it('reports per-item success and failure without stopping on the first error', async () => {
      txRepo.findOne
        .mockResolvedValueOnce({
          id: 'a',
          name: 'A',
          email: 'a@example.com',
          status: PlatformJoinRequestStatus.Pending,
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'c',
          name: 'C',
          email: 'c@example.com',
          status: PlatformJoinRequestStatus.Pending,
        });
      const result = await service.bulkReview(
        ['a', 'b', 'c'],
        'admin-1',
        PlatformJoinRequestStatus.Declined,
        'spam_pattern',
      );
      expect(result.succeeded).toEqual(['a', 'c']);
      expect(result.failed).toEqual([
        { id: 'b', reason: 'Join request not found' },
      ]);
    });
  });

  describe('sample', () => {
    it('queries only approved/declined requests, ordered randomly, limited to n', async () => {
      qb.getMany.mockResolvedValue([]);
      await service.sample(5);
      expect(qb.where).toHaveBeenCalledWith('jr.status IN (:...statuses)', {
        statuses: [
          PlatformJoinRequestStatus.Approved,
          PlatformJoinRequestStatus.Declined,
        ],
      });
      expect(qb.orderBy).toHaveBeenCalledWith('RANDOM()');
      expect(qb.limit).toHaveBeenCalledWith(5);
    });

    it('names the deciding reviewer in ONE batched lookup for the whole draw', async () => {
      const decided = (id: string, reviewedBy: string | null) =>
        ({
          id,
          name: id,
          email: `${id}@example.com`,
          status: PlatformJoinRequestStatus.Approved,
          reviewedBy,
          assignedStaffId: null,
          inviteId: null,
        }) as unknown as PlatformJoinRequest;
      qb.getMany.mockResolvedValue([
        decided('one', 'reviewer-ana'),
        decided('two', 'reviewer-ana'),
        decided('three', 'reviewer-luis'),
      ]);
      profileRepo.find.mockResolvedValue([
        { userId: 'reviewer-ana', firstName: 'Ana', lastName: 'Reis' },
        { userId: 'reviewer-luis', firstName: 'Luís', lastName: 'Matos' },
      ]);

      const rows = await service.sample(3);

      expect(rows.map((row) => row.reviewedByName)).toEqual([
        'Ana Reis',
        'Ana Reis',
        'Luís Matos',
      ]);
      // The id stays beside the name: the sample groups on it, and a name is
      // not stable enough to group on.
      expect(rows.map((row) => row.reviewedBy)).toEqual([
        'reviewer-ana',
        'reviewer-ana',
        'reviewer-luis',
      ]);
      // Three rows, two distinct reviewers, ONE profile query. This is the N+1 that
      // batching exists to prevent.
      expect(profileRepo.find).toHaveBeenCalledTimes(1);
      expect(profileRepo.find).toHaveBeenCalledWith({
        where: { userId: In(['reviewer-ana', 'reviewer-luis']) },
      });
    });

    it('leaves the reviewer name off a row whose reviewer was erased, rather than inventing one', async () => {
      // `join_requests.reviewed_by` is ON DELETE SET NULL, so erasure takes the
      // id with it. There is nothing left to resolve, and nothing here may put
      // a name back.
      qb.getMany.mockResolvedValue([
        {
          id: 'erased',
          name: 'Sam',
          email: 'sam@example.com',
          status: PlatformJoinRequestStatus.Declined,
          reviewedBy: null,
          assignedStaffId: null,
          inviteId: null,
        },
      ]);

      const rows = await service.sample(1);

      expect(rows[0]!.reviewedBy).toBeNull();
      expect(rows[0]).not.toHaveProperty('reviewedByName');
      // Nothing to look up, so no query is issued at all.
      expect(profileRepo.find).not.toHaveBeenCalled();
    });

    it('falls back to the neutral member label when a reviewer has no profile row', async () => {
      qb.getMany.mockResolvedValue([
        {
          id: 'no-profile',
          name: 'Sam',
          email: 'sam@example.com',
          status: PlatformJoinRequestStatus.Approved,
          reviewedBy: 'reviewer-without-profile',
          assignedStaffId: null,
          inviteId: null,
        },
      ]);
      profileRepo.find.mockResolvedValue([]);

      const rows = await service.sample(1);

      // Never their email: this label is shown to OTHER reviewers.
      expect(rows[0]!.reviewedByName).toBe('Member');
    });
  });
});
