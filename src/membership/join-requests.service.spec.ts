import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { JoinRequest, JoinRequestStatus } from './entities/join-request.entity';
import { InvitesService } from './invites.service';
import { JoinRequestsService } from './join-requests.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

const uniqueViolation = () =>
  new QueryFailedError('insert', [], {
    code: '23505',
  } as unknown as Error);

const dto = (overrides: Partial<CreateJoinRequestDto> = {}) =>
  ({
    name: 'Sam Costa',
    email: 'sam@example.com',
    city: 'Lisbon',
    message: 'let me in',
    ageAttested: true,
    termsVersion: '2.4',
    ...overrides,
  }) as CreateJoinRequestDto;

describe('JoinRequestsService', () => {
  let service: JoinRequestsService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qb: { where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock };
  let txRepo: { findOne: jest.Mock; update: jest.Mock };
  let invites: { createInviteForApproval: jest.Mock };
  let inviteRepo: { find: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };
  let manager: { getRepository: jest.Mock };
  let platformSettings: { get: jest.Mock };

  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    txRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(async (r) => ({
        id: 'r1',
        createdAt: new Date('2026-07-18T00:00:00.000Z'),
        ...r,
      })),
      create: jest.fn((v) => v),
      createQueryBuilder: jest.fn(() => qb),
    };
    invites = {
      createInviteForApproval: jest
        .fn()
        .mockResolvedValue({ id: 'inv-1', code: 'QP-ABCD-EFGH' }),
    };
    inviteRepo = { find: jest.fn().mockResolvedValue([]) };
    manager = { getRepository: jest.fn(() => txRepo) };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
      getRepository: jest.fn(() => inviteRepo),
    };
    // Join-request kill switch — on by default, so submission is unaffected
    // unless a test explicitly turns it off.
    platformSettings = {
      get: jest.fn().mockResolvedValue({
        joinRequestsEnabled: true,
        registrationClosedMessage: null,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JoinRequestsService,
        { provide: getRepositoryToken(JoinRequest), useValue: repo },
        { provide: InvitesService, useValue: invites },
        { provide: DataSource, useValue: dataSource },
        { provide: PlatformSettingsService, useValue: platformSettings },
      ],
    }).compile();
    service = module.get(JoinRequestsService);
  });

  describe('submit', () => {
    it('persists a pending request and returns only { id, status, createdAt }', async () => {
      const res = await service.submit(dto());
      expect(repo.save).toHaveBeenCalled();
      expect(res.status).toBe(JoinRequestStatus.Pending);
      expect(Object.keys(res).sort()).toEqual(['createdAt', 'id', 'status']);
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
          ageAttestedAt: expect.any(Date),
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
          response: expect.objectContaining({ code: 'UNDER_18' }),
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
          expect.objectContaining({ status: JoinRequestStatus.Pending }),
        );
      });

      it('accepts a submission with no DOB at all (attestation is the gate)', async () => {
        await expect(service.submit(dto())).resolves.toEqual(
          expect.objectContaining({ status: JoinRequestStatus.Pending }),
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

  describe('list', () => {
    const row = (overrides = {}) =>
      ({
        id: 'r1',
        name: 'Sam',
        email: 'sam@example.com',
        city: null,
        message: 'hi',
        status: JoinRequestStatus.Pending,
        ageAttestedAt: new Date(),
        termsVersion: '2.4',
        reviewedBy: null,
        reviewedAt: null,
        inviteId: null,
        createdAt: new Date(),
        ...overrides,
      }) as JoinRequest;

    it('returns inviteCode null for rows with no invite, without querying invites', async () => {
      repo.find.mockResolvedValue([row()]);
      const [view] = await service.list();
      expect(view.inviteCode).toBeNull();
      expect(inviteRepo.find).not.toHaveBeenCalled();
    });

    it('resolves invite codes in ONE query for the whole page', async () => {
      repo.find.mockResolvedValue([
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
      await service.list(JoinRequestStatus.Approved);
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: JoinRequestStatus.Approved },
        }),
      );
    });
  });

  describe('review', () => {
    const pendingRow = () => ({
      id: 'r1',
      email: 'sam@example.com',
      status: JoinRequestStatus.Pending,
    });

    it('approving mints an invite bound to the email, on the SAME manager', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      const result = await service.review(
        'r1',
        'admin-1',
        JoinRequestStatus.Approved,
      );

      expect(invites.createInviteForApproval).toHaveBeenCalledWith(
        manager,
        'admin-1',
        'sam@example.com',
      );
      expect(result.inviteCode).toBe('QP-ABCD-EFGH');
      expect(result.status).toBe(JoinRequestStatus.Approved);
      expect(result.reviewedBy).toBe('admin-1');
    });

    it('records the approving admin as the inviter', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      await service.review('r1', 'admin-7', JoinRequestStatus.Approved);
      expect(invites.createInviteForApproval).toHaveBeenCalledWith(
        expect.anything(),
        'admin-7',
        expect.any(String),
      );
    });

    it('writes invite_id in the same UPDATE as the status flip', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      await service.review('r1', 'admin-1', JoinRequestStatus.Approved);
      expect(txRepo.update).toHaveBeenCalledWith(
        { id: 'r1', status: JoinRequestStatus.Pending },
        expect.objectContaining({
          status: JoinRequestStatus.Approved,
          reviewedBy: 'admin-1',
          reviewedAt: expect.any(Date),
          inviteId: 'inv-1',
        }),
      );
    });

    it('declines without minting an invite', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      const result = await service.review(
        'r1',
        'admin-1',
        JoinRequestStatus.Declined,
      );
      expect(invites.createInviteForApproval).not.toHaveBeenCalled();
      expect(result.inviteCode).toBeNull();
      expect(txRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inviteId: null }),
      );
    });

    it('404s on an unknown request', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await expect(
        service.review('nope', 'admin-1', JoinRequestStatus.Approved),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an already-reviewed request with 409', async () => {
      txRepo.findOne.mockResolvedValue({
        ...pendingRow(),
        status: JoinRequestStatus.Approved,
      });
      await expect(
        service.review('r1', 'admin-1', JoinRequestStatus.Approved),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(invites.createInviteForApproval).not.toHaveBeenCalled();
    });

    it('rejects when a concurrent reviewer already claimed it (affected 0)', async () => {
      txRepo.findOne.mockResolvedValue(pendingRow());
      txRepo.update.mockResolvedValue({ affected: 0 });
      // The mint already ran, but the throw rolls the whole transaction back,
      // so the orphaned invite never commits.
      await expect(
        service.review('r1', 'admin-1', JoinRequestStatus.Approved),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
