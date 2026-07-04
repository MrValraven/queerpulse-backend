import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InvitesService } from '../membership/invites.service';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { RefreshToken } from './entities/refresh-token.entity';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('AuthService.rotateRefreshToken', () => {
  let service: AuthService;
  let repo: {
    findOne: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let jwt: { verifyAsync: jest.Mock; signAsync: jest.Mock; decode: jest.Mock };
  let users: {
    findById: jest.Mock;
    findByGoogleId: jest.Mock;
    createGoogleUser: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let invites: { validateInviteForSignup: jest.Mock; claimInvite: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ id: 'new-row', ...v })),
    };
    jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1' }),
      signAsync: jest.fn().mockResolvedValue('signed'),
      decode: jest.fn().mockReturnValue({ exp: 9999999999 }),
    };
    users = {
      findById: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'a@b.c',
        status: 'active',
        role: 'member',
      }),
      findByGoogleId: jest.fn(),
      createGoogleUser: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(async (cb: any) => cb({/* fake manager */})),
    };
    invites = {
      validateInviteForSignup: jest.fn(),
      claimInvite: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: JwtService, useValue: jwt },
        { provide: UsersService, useValue: users },
        { provide: getRepositoryToken(RefreshToken), useValue: repo },
        {
          provide: ConfigService,
          useValue: { get: () => '30d', getOrThrow: () => 'secret' },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: InvitesService, useValue: invites },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('rotates a valid token: revokes the old row and issues a new one', async () => {
    repo.findOne.mockResolvedValue({
      id: 'old-row',
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await service.rotateRefreshToken('raw-token', 'agent');
    expect(result).toEqual({ accessToken: 'signed', refreshToken: 'signed' });
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw-token') },
    });
    expect(repo.update).toHaveBeenCalledWith(
      'old-row',
      expect.objectContaining({ replacedBy: 'new-row' }),
    );
  });

  it("detects reuse of an already-revoked token: revokes all of the user's tokens and throws", async () => {
    repo.findOne.mockResolvedValue({
      id: 'old-row',
      userId: 'u1',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      service.rotateRefreshToken('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.update).toHaveBeenCalledWith(
      { userId: 'u1', revokedAt: expect.anything() },
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it('rejects an unknown token', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(
      service.rotateRefreshToken('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('validateOrCreateGoogleUser', () => {
  let service: AuthService;
  let repo: {
    findOne: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let jwt: { verifyAsync: jest.Mock; signAsync: jest.Mock; decode: jest.Mock };
  let users: {
    findById: jest.Mock;
    findByGoogleId: jest.Mock;
    createGoogleUser: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let invites: { validateInviteForSignup: jest.Mock; claimInvite: jest.Mock };
  let events: { emit: jest.Mock };

  const profile = {
    googleId: 'g-1',
    email: 'a@b.c',
    firstName: 'Ada',
    lastName: 'Lovelace',
    avatarUrl: null,
  };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ id: 'new-row', ...v })),
    };
    jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1' }),
      signAsync: jest.fn().mockResolvedValue('signed'),
      decode: jest.fn().mockReturnValue({ exp: 9999999999 }),
    };
    users = {
      findById: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'a@b.c',
        status: 'active',
        role: 'member',
      }),
      findByGoogleId: jest.fn(),
      createGoogleUser: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(async (cb: any) => cb({/* fake manager */})),
    };
    invites = {
      validateInviteForSignup: jest.fn(),
      claimInvite: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: JwtService, useValue: jwt },
        { provide: UsersService, useValue: users },
        { provide: getRepositoryToken(RefreshToken), useValue: repo },
        {
          provide: ConfigService,
          useValue: { get: () => '30d', getOrThrow: () => 'secret' },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: InvitesService, useValue: invites },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('returns the existing user by googleId without needing an invite', async () => {
    const existing = { id: 'u1', status: UserStatus.Active };
    users.findByGoogleId = jest.fn().mockResolvedValue(existing);
    await expect(service.validateOrCreateGoogleUser(profile)).resolves.toBe(
      existing,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a new user with no invite code (invite_required)', async () => {
    users.findByGoogleId = jest.fn().mockResolvedValue(null);
    await expect(
      service.validateOrCreateGoogleUser(profile, undefined),
    ).rejects.toMatchObject({ reason: 'invite_required' });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('creates an Active member, consumes the invite, and emits USER_PROMOTED', async () => {
    users.findByGoogleId = jest.fn().mockResolvedValue(null);
    invites.validateInviteForSignup = jest
      .fn()
      .mockResolvedValue({ inviteId: 'inv-1', inviterId: 'inviter-1' });
    users.createGoogleUser = jest
      .fn()
      .mockResolvedValue({ id: 'new-user', status: UserStatus.Active });

    const user = await service.validateOrCreateGoogleUser(profile, 'CODE');

    expect(user).toEqual(expect.objectContaining({ id: 'new-user' }));
    expect(invites.validateInviteForSignup).toHaveBeenCalledWith(
      expect.anything(),
      'CODE',
      'a@b.c',
    );
    expect(users.createGoogleUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        googleId: 'g-1',
        status: UserStatus.Active,
        invitedBy: 'inviter-1',
      }),
    );
    expect(invites.claimInvite).toHaveBeenCalledWith(
      expect.anything(),
      'inv-1',
      'new-user',
    );
    expect(events.emit).toHaveBeenCalledWith(
      'user.promoted',
      expect.objectContaining({ userId: 'new-user' }),
    );
  });

  it('propagates SignupRejectedError when the invite is invalid', async () => {
    users.findByGoogleId = jest.fn().mockResolvedValue(null);
    invites.validateInviteForSignup = jest
      .fn()
      .mockRejectedValue(new SignupRejectedError('invite_invalid'));
    await expect(
      service.validateOrCreateGoogleUser(profile, 'CODE'),
    ).rejects.toMatchObject({ reason: 'invite_invalid' });
  });
});
