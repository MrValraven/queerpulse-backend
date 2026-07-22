import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Not } from 'typeorm';
import { Invite, InviteStatus } from '../membership/entities/invite.entity';
import { InvitesService } from '../membership/invites.service';
import { User, UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { HOUSE_GOOGLE_ID } from './genesis.constants';
import { GenesisService } from './genesis.service';

const GENESIS_EMAIL = 'akatiago@gmail.com';
const HOUSE_ACCOUNT = { id: 'house-1', googleId: HOUSE_GOOGLE_ID } as User;

describe('GenesisService', () => {
  let service: GenesisService;
  let users: { findOne: jest.Mock; count: jest.Mock; update: jest.Mock };
  let invites: { findOne: jest.Mock; update: jest.Mock };
  let usersService: { createGoogleUser: jest.Mock };
  let invitesService: { createInviteForApproval: jest.Mock };
  let configuredEmail: string | null;

  beforeEach(async () => {
    configuredEmail = GENESIS_EMAIL;
    users = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    invites = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    usersService = {
      createGoogleUser: jest.fn().mockResolvedValue(HOUSE_ACCOUNT),
    };
    invitesService = {
      createInviteForApproval: jest
        .fn()
        .mockResolvedValue({ id: 'invite-1', code: 'ABCD2345' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GenesisService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Invite), useValue: invites },
        { provide: UsersService, useValue: usersService },
        { provide: InvitesService, useValue: invitesService },
        {
          provide: DataSource,
          useValue: {
            transaction: (runInTransaction: (manager: unknown) => unknown) =>
              runInTransaction({}),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => configuredEmail) },
        },
      ],
    }).compile();

    service = module.get(GenesisService);
  });

  describe('mintGenesisInvite', () => {
    it('404s when GENESIS_EMAIL is unset', async () => {
      configuredEmail = null;
      await expect(service.mintGenesisInvite()).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s once a user other than the house account exists', async () => {
      users.count.mockResolvedValue(1);
      await expect(service.mintGenesisInvite()).rejects.toThrow(
        NotFoundException,
      );
    });

    it('counts real members excluding the house account itself', async () => {
      users.findOne.mockResolvedValue(HOUSE_ACCOUNT);

      await service.mintGenesisInvite();

      expect(users.count).toHaveBeenCalledWith({
        where: { id: Not(HOUSE_ACCOUNT.id) },
      });
    });

    it('mints successfully when the house account is the only existing user', async () => {
      users.findOne.mockResolvedValue(HOUSE_ACCOUNT);
      users.count.mockResolvedValue(0);

      const result = await service.mintGenesisInvite();

      expect(result).toEqual({ code: 'ABCD2345' });
    });

    it('creates the house account and mints an invite pinned to the founder', async () => {
      const result = await service.mintGenesisInvite();

      expect(usersService.createGoogleUser).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ googleId: HOUSE_GOOGLE_ID }),
      );
      expect(invitesService.createInviteForApproval).toHaveBeenCalledWith(
        expect.anything(),
        HOUSE_ACCOUNT.id,
        GENESIS_EMAIL,
      );
      expect(result).toEqual({ code: 'ABCD2345' });
    });

    it('reuses the existing pending invite instead of minting a second one', async () => {
      users.findOne.mockResolvedValue(HOUSE_ACCOUNT);
      invites.findOne.mockResolvedValue({
        id: 'invite-1',
        code: 'EXISTING1',
        email: GENESIS_EMAIL,
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.mintGenesisInvite();

      expect(result).toEqual({ code: 'EXISTING1' });
      expect(invitesService.createInviteForApproval).not.toHaveBeenCalled();
      expect(usersService.createGoogleUser).not.toHaveBeenCalled();
    });

    it('reuses the existing pending invite when the stored email differs only in case', async () => {
      users.findOne.mockResolvedValue(HOUSE_ACCOUNT);
      invites.findOne.mockResolvedValue({
        id: 'invite-1',
        code: 'EXISTING1',
        email: 'AkaTiago@Gmail.com',
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.mintGenesisInvite();

      expect(result).toEqual({ code: 'EXISTING1' });
      expect(invitesService.createInviteForApproval).not.toHaveBeenCalled();
    });

    it('revokes and re-mints when the pinned email no longer matches', async () => {
      users.findOne.mockResolvedValue(HOUSE_ACCOUNT);
      invites.findOne.mockResolvedValue({
        id: 'invite-stale',
        code: 'STALE123',
        email: 'someone-else@example.com',
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.mintGenesisInvite();

      expect(invites.update).toHaveBeenCalledWith(
        { id: 'invite-stale', status: InviteStatus.Pending },
        { status: InviteStatus.Revoked },
      );
      expect(result).toEqual({ code: 'ABCD2345' });
    });

    it('re-mints when the existing invite has expired', async () => {
      users.findOne.mockResolvedValue(HOUSE_ACCOUNT);
      invites.findOne.mockResolvedValue({
        id: 'invite-old',
        code: 'OLD12345',
        email: GENESIS_EMAIL,
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() - 60_000),
      });

      const result = await service.mintGenesisInvite();

      expect(result).toEqual({ code: 'ABCD2345' });
    });
  });

  describe('claimAdmin', () => {
    it('404s when GENESIS_EMAIL is unset', async () => {
      configuredEmail = null;
      await expect(service.claimAdmin('user-1', GENESIS_EMAIL)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects a caller whose email is not the genesis email', async () => {
      await expect(
        service.claimAdmin('user-1', 'someone-else@example.com'),
      ).rejects.toThrow(ForbiddenException);
      expect(users.update).not.toHaveBeenCalled();
    });

    it('matches the genesis email case-insensitively', async () => {
      await service.claimAdmin('user-1', 'AkaTiago@Gmail.com');
      expect(users.update).toHaveBeenCalledWith(
        { id: 'user-1' },
        { role: UserRole.Admin },
      );
    });

    it('rejects once any admin already exists', async () => {
      users.count.mockResolvedValue(1);
      await expect(service.claimAdmin('user-1', GENESIS_EMAIL)).rejects.toThrow(
        ForbiddenException,
      );
      expect(users.update).not.toHaveBeenCalled();
    });

    it('promotes the caller to admin', async () => {
      await service.claimAdmin('user-1', GENESIS_EMAIL);
      expect(users.update).toHaveBeenCalledWith(
        { id: 'user-1' },
        { role: UserRole.Admin },
      );
    });
  });
});
