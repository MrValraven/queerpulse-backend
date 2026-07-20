import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from '../account/entities/deletion-request.entity';
import { EmailSuppression } from '../account/entities/email-suppression.entity';
import { InvitesService } from '../membership/invites.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { RefreshToken } from './entities/refresh-token.entity';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

interface RepoMock {
  findOne: jest.Mock;
  update: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}
interface JwtMock {
  verifyAsync: jest.Mock;
  signAsync: jest.Mock;
  decode: jest.Mock;
}
interface UsersMock {
  findById: jest.Mock;
  findByGoogleId: jest.Mock;
  createGoogleUser: jest.Mock;
}

function buildMocks() {
  const repo: RepoMock = {
    findOne: jest.fn(),
    // Every update resolves an UpdateResult-shaped object with `affected`.
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((v: Record<string, unknown>) => v),
    save: jest.fn(async (v: Record<string, unknown>) => ({
      id: 'new-row',
      ...v,
    })),
  };
  const jwt: JwtMock = {
    verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1' }),
    signAsync: jest.fn().mockResolvedValue('signed'),
    decode: jest.fn().mockReturnValue({ exp: 9999999999 }),
  };
  const users: UsersMock = {
    findById: jest.fn().mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    }),
    findByGoogleId: jest.fn(),
    createGoogleUser: jest.fn(),
  };
  // The transaction manager exposes getRepository so the atomic rotation can
  // run its conditional claim + insert through the same (mock) repo, plus a
  // direct `update` for the reactivate-on-sign-in path (which updates `User`
  // and `AccountDeactivation` by entity class rather than via a repository).
  const managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const dataSource = {
    transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
      cb({ getRepository: () => repo, update: managerUpdate }),
    ),
  };
  const invites = {
    validateInviteForSignup: jest.fn(),
    claimInvite: jest.fn().mockResolvedValue(undefined),
  };
  const events = { emit: jest.fn() };
  // Erasure suppression list — empty by default, so signup is unaffected
  // unless a test explicitly makes an address suppressed.
  const suppressions = { findOne: jest.fn().mockResolvedValue(null) };
  // Read-only in AuthService: they only decide whether a returning
  // `deactivated` member is coming back from a reversible pause (reactivate)
  // or from a pending erasure (leave alone). Empty by default.
  const deactivations = { findOne: jest.fn().mockResolvedValue(null) };
  const deletionRequests = { findOne: jest.fn().mockResolvedValue(null) };
  // Registration kill switch — on by default, so signup is unaffected unless
  // a test explicitly turns it off.
  const platformSettings = {
    get: jest.fn().mockResolvedValue({ registrationEnabled: true }),
  };
  return {
    repo,
    jwt,
    users,
    dataSource,
    managerUpdate,
    invites,
    events,
    suppressions,
    deactivations,
    deletionRequests,
    platformSettings,
  };
}

async function buildService(
  mocks: ReturnType<typeof buildMocks>,
): Promise<AuthService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: JwtService, useValue: mocks.jwt },
      { provide: UsersService, useValue: mocks.users },
      { provide: getRepositoryToken(RefreshToken), useValue: mocks.repo },
      {
        provide: ConfigService,
        useValue: { get: () => '30d', getOrThrow: () => 'secret' },
      },
      { provide: DataSource, useValue: mocks.dataSource },
      { provide: InvitesService, useValue: mocks.invites },
      { provide: EventEmitter2, useValue: mocks.events },
      {
        provide: getRepositoryToken(EmailSuppression),
        useValue: mocks.suppressions,
      },
      {
        provide: getRepositoryToken(AccountDeactivation),
        useValue: mocks.deactivations,
      },
      {
        provide: getRepositoryToken(DeletionRequest),
        useValue: mocks.deletionRequests,
      },
      {
        provide: PlatformSettingsService,
        useValue: mocks.platformSettings,
      },
    ],
  }).compile();
  return module.get(AuthService);
}

describe('AuthService.rotateRefreshToken', () => {
  let service: AuthService;
  let mocks: ReturnType<typeof buildMocks>;

  const liveRow = () => ({
    id: 'old-row',
    userId: 'u1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('rotates a valid token: atomically claims the old row and issues a new pair', async () => {
    mocks.repo.findOne.mockResolvedValue(liveRow());

    const result = await service.rotateRefreshToken('raw-token', 'agent');

    expect(result).toEqual({ accessToken: 'signed', refreshToken: 'signed' });
    expect(mocks.repo.findOne).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw-token') },
    });
    // Rotation happens inside a single transaction.
    expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
    // The claim is conditional (only the un-revoked row) and links replaced_by.
    expect(mocks.repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'old-row' }),
      expect.objectContaining({
        revokedAt: expect.any(Date),
        replacedBy: expect.any(String),
      }),
    );
    // A brand-new row was persisted with the pre-generated id used in the claim.
    const claimReplacement = mocks.repo.update.mock.calls[0][1].replacedBy;
    expect(mocks.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: claimReplacement, userId: 'u1' }),
    );
    expect(mocks.repo.save).toHaveBeenCalledTimes(1);
  });

  it('detects reuse of an already-revoked token: revokes the whole family and throws', async () => {
    mocks.repo.findOne.mockResolvedValue({
      ...liveRow(),
      revokedAt: new Date(),
    });

    await expect(
      service.rotateRefreshToken('raw-token', 'agent'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Whole family revoked; no rotation transaction started.
    expect(mocks.repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
    expect(mocks.repo.save).not.toHaveBeenCalled();
    // A compromise signal — the member's live socket must be dropped too.
    expect(mocks.events.emit).toHaveBeenCalledWith('user.session.revoked', {
      userId: 'u1',
    });
  });

  it('treats a lost claim race (affected === 0) as reuse: revokes family, issues nothing', async () => {
    mocks.repo.findOne.mockResolvedValue(liveRow());
    // Claim (where has `id`) loses the race; family revoke (where has `userId`) wins.
    mocks.repo.update.mockImplementation((where: Record<string, unknown>) =>
      Promise.resolve({ affected: where && 'id' in where ? 0 : 2 }),
    );

    await expect(
      service.rotateRefreshToken('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // No new token was minted for a token that lost the claim.
    expect(mocks.repo.save).not.toHaveBeenCalled();
    // The family was revoked (reuse response).
    expect(mocks.repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it('rejects an unknown token (no allowlist row)', async () => {
    mocks.repo.findOne.mockResolvedValue(null);
    await expect(
      service.rotateRefreshToken('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects an expired allowlist row', async () => {
    mocks.repo.findOne.mockResolvedValue({
      ...liveRow(),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      service.rotateRefreshToken('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects when the user no longer exists', async () => {
    mocks.repo.findOne.mockResolvedValue(liveRow());
    mocks.users.findById.mockResolvedValue(null);
    await expect(
      service.rotateRefreshToken('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature before touching the allowlist', async () => {
    mocks.jwt.verifyAsync.mockRejectedValue(new Error('bad signature'));
    await expect(
      service.rotateRefreshToken('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mocks.repo.findOne).not.toHaveBeenCalled();
  });
});

describe('AuthService.revokeRefreshToken / revokeAllForUser', () => {
  let service: AuthService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('revokeRefreshToken looks up the row by hash, revokes it, and drops the session', async () => {
    mocks.repo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      revokedAt: null,
    });
    await service.revokeRefreshToken('raw-token');
    expect(mocks.repo.findOne).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw-token') },
    });
    expect(mocks.repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1' }),
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
    expect(mocks.events.emit).toHaveBeenCalledWith('user.session.revoked', {
      userId: 'u1',
    });
  });

  it('revokeRefreshToken is a no-op when the token is unknown', async () => {
    mocks.repo.findOne.mockResolvedValue(null);
    await expect(
      service.revokeRefreshToken('raw-token'),
    ).resolves.toBeUndefined();
    expect(mocks.repo.update).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });

  it('revokeRefreshToken is a no-op when the token was already revoked', async () => {
    mocks.repo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      revokedAt: new Date(),
    });
    await service.revokeRefreshToken('raw-token');
    expect(mocks.repo.update).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });

  it('revokeAllForUser revokes every live row and drops the session', async () => {
    await service.revokeAllForUser('u1');
    expect(mocks.repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
    expect(mocks.events.emit).toHaveBeenCalledWith('user.session.revoked', {
      userId: 'u1',
    });
  });
});

describe('AuthService.validateOrCreateGoogleUser', () => {
  let service: AuthService;
  let mocks: ReturnType<typeof buildMocks>;

  const profile = {
    googleId: 'g-1',
    email: 'a@b.c',
    firstName: 'Ada',
    lastName: 'Lovelace',
    avatarUrl: null,
  };

  /** The 18+ attestation every new signup must carry (Terms §eligibility). */
  const attested = { ageAttested: true, termsVersion: '2.4' };

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('returns the existing user by googleId without needing an invite', async () => {
    const existing = { id: 'u1', status: UserStatus.Active };
    mocks.users.findByGoogleId.mockResolvedValue(existing);
    await expect(service.validateOrCreateGoogleUser(profile)).resolves.toBe(
      existing,
    );
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
  });

  // "Reactivate by signing back in with Google" vs. "you have 30 days to
  // change your mind" — same `users.status`, opposite meanings.
  describe('returning deactivated member', () => {
    it('DOES reactivate a member coming back from a deactivation', async () => {
      const existing = { id: 'u1', status: UserStatus.Deactivated };
      mocks.users.findByGoogleId.mockResolvedValue(existing);
      mocks.deactivations.findOne.mockResolvedValue({
        id: 'deact-1',
        userId: 'u1',
        reactivatedAt: null,
        previousStatus: UserStatus.Active,
      });

      const user = await service.validateOrCreateGoogleUser(profile);

      expect(user.status).toBe(UserStatus.Active);
      // Stamps `reactivated_at` and flips the status, both conditionally.
      expect(mocks.managerUpdate).toHaveBeenCalledWith(
        AccountDeactivation,
        expect.objectContaining({ id: 'deact-1' }),
        expect.objectContaining({ reactivatedAt: expect.any(Date) }),
      );
      expect(mocks.managerUpdate).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ status: UserStatus.Deactivated }),
        { status: UserStatus.Active },
      );
    });

    it('restores Suspended, not Active — deactivation cannot launder a suspension', async () => {
      const existing = { id: 'u1', status: UserStatus.Deactivated };
      mocks.users.findByGoogleId.mockResolvedValue(existing);
      mocks.deactivations.findOne.mockResolvedValue({
        id: 'deact-1',
        userId: 'u1',
        reactivatedAt: null,
        previousStatus: UserStatus.Suspended,
      });

      const user = await service.validateOrCreateGoogleUser(profile);

      expect(user.status).toBe(UserStatus.Suspended);
      expect(mocks.managerUpdate).toHaveBeenCalledWith(
        User,
        expect.anything(),
        { status: UserStatus.Suspended },
      );
    });

    it('does NOT reactivate a member in the deletion grace period', async () => {
      // 🔴 Signing in must never silently cancel an erasure request. The only
      // way back is the explicit DELETE /account/deletion-request.
      const existing = { id: 'u1', status: UserStatus.Deactivated };
      mocks.users.findByGoogleId.mockResolvedValue(existing);
      mocks.deletionRequests.findOne.mockResolvedValue({
        id: 'del-1',
        userId: 'u1',
        status: DeletionRequestStatus.Grace,
        previousStatus: UserStatus.Active,
      });
      // Both rows present: deactivated first, then asked to be erased. The
      // erasure request wins.
      mocks.deactivations.findOne.mockResolvedValue({
        id: 'deact-1',
        userId: 'u1',
        reactivatedAt: null,
        previousStatus: UserStatus.Active,
      });

      const user = await service.validateOrCreateGoogleUser(profile);

      expect(user.status).toBe(UserStatus.Deactivated);
      expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
      expect(mocks.managerUpdate).not.toHaveBeenCalled();
    });

    it('leaves a deactivated member with no ledger row alone', async () => {
      const existing = { id: 'u1', status: UserStatus.Deactivated };
      mocks.users.findByGoogleId.mockResolvedValue(existing);
      mocks.deactivations.findOne.mockResolvedValue(null);
      mocks.deletionRequests.findOne.mockResolvedValue(null);

      const user = await service.validateOrCreateGoogleUser(profile);

      // No recorded status to restore — guessing Active would be a privilege
      // grant.
      expect(user.status).toBe(UserStatus.Deactivated);
      expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  it('rejects a new user with no invite code (invite_required)', async () => {
    mocks.users.findByGoogleId.mockResolvedValue(null);
    await expect(
      service.validateOrCreateGoogleUser(profile, undefined, attested),
    ).rejects.toMatchObject({ reason: 'invite_required' });
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a new user who has not attested to being 18+', async () => {
    mocks.users.findByGoogleId.mockResolvedValue(null);
    await expect(
      service.validateOrCreateGoogleUser(profile, 'CODE'),
    ).rejects.toMatchObject({ reason: 'age_attestation_required' });
    await expect(
      service.validateOrCreateGoogleUser(profile, 'CODE', {
        ageAttested: false,
      }),
    ).rejects.toMatchObject({ reason: 'age_attestation_required' });
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('lets an EXISTING member sign in without attesting (they predate the gate)', async () => {
    const existing = { id: 'u1', status: UserStatus.Active };
    mocks.users.findByGoogleId.mockResolvedValue(existing);
    await expect(service.validateOrCreateGoogleUser(profile)).resolves.toBe(
      existing,
    );
  });

  it('creates an Active member, consumes the invite, and emits USER_PROMOTED', async () => {
    mocks.users.findByGoogleId.mockResolvedValue(null);
    mocks.invites.validateInviteForSignup.mockResolvedValue({
      inviteId: 'inv-1',
      inviterId: 'inviter-1',
    });
    mocks.users.createGoogleUser.mockResolvedValue({
      id: 'new-user',
      status: UserStatus.Active,
    });

    const user = await service.validateOrCreateGoogleUser(
      profile,
      'CODE',
      attested,
    );

    expect(user).toEqual(expect.objectContaining({ id: 'new-user' }));
    expect(mocks.invites.validateInviteForSignup).toHaveBeenCalledWith(
      expect.anything(),
      'CODE',
      'a@b.c',
    );
    expect(mocks.users.createGoogleUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        googleId: 'g-1',
        status: UserStatus.Active,
        invitedBy: 'inviter-1',
        ageAttestedAt: expect.any(Date),
        termsVersion: '2.4',
      }),
    );
    expect(mocks.invites.claimInvite).toHaveBeenCalledWith(
      expect.anything(),
      'inv-1',
      'new-user',
    );
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'user.promoted',
      expect.objectContaining({ userId: 'new-user' }),
    );
  });

  it('propagates SignupRejectedError when the invite is invalid', async () => {
    mocks.users.findByGoogleId.mockResolvedValue(null);
    mocks.invites.validateInviteForSignup.mockRejectedValue(
      new SignupRejectedError('invite_invalid'),
    );
    await expect(
      service.validateOrCreateGoogleUser(profile, 'CODE', attested),
    ).rejects.toMatchObject({ reason: 'invite_invalid' });
  });

  describe('registration kill switch', () => {
    it('rejects a new signup with registration_disabled when registration is off', async () => {
      mocks.platformSettings.get.mockResolvedValue({
        registrationEnabled: false,
      });
      mocks.users.findByGoogleId.mockResolvedValue(null);

      await expect(
        service.validateOrCreateGoogleUser(
          {
            googleId: 'g-new',
            email: 'new@example.com',
            firstName: 'New',
            lastName: 'Person',
          },
          'INVITE123',
          { ageAttested: true },
        ),
      ).rejects.toMatchObject({ reason: 'registration_disabled' });
    });

    it('still signs in a returning member while registration is off', async () => {
      // The whole point of the flag: stop new accounts, do not lock out the
      // community. This asserts the check sits AFTER the existing-user return.
      const existing = { id: 'u-1', status: UserStatus.Active } as User;
      mocks.platformSettings.get.mockResolvedValue({
        registrationEnabled: false,
      });
      mocks.users.findByGoogleId.mockResolvedValue(existing);

      await expect(
        service.validateOrCreateGoogleUser({
          googleId: 'g-existing',
          email: 'existing@example.com',
          firstName: 'Existing',
          lastName: 'Member',
        }),
      ).resolves.toBe(existing);
    });

    it('rejects a new signup while locked down even though registration is enabled', async () => {
      // AuthController is @LockdownExempt() so PlatformLockdownGuard never sees
      // this request — without the lockdown arm of this check, anyone holding a
      // valid invite would still create a User row on a fully locked platform.
      mocks.platformSettings.get.mockResolvedValue({
        registrationEnabled: true,
        lockdownEnabled: true,
      });
      mocks.users.findByGoogleId.mockResolvedValue(null);

      await expect(
        service.validateOrCreateGoogleUser(profile, 'INVITE123', attested),
      ).rejects.toMatchObject({ reason: 'registration_disabled' });
      // Rejected before any account was written.
      expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
      expect(mocks.users.createGoogleUser).not.toHaveBeenCalled();
    });

    it('still signs in a returning member while locked down', async () => {
      // Essential: an admin has to be able to authenticate in order to LIFT the
      // lockdown. The check must stay after the existing-googleId short-circuit.
      const existing = { id: 'u-1', status: UserStatus.Active } as User;
      mocks.platformSettings.get.mockResolvedValue({
        registrationEnabled: true,
        lockdownEnabled: true,
      });
      mocks.users.findByGoogleId.mockResolvedValue(existing);

      await expect(service.validateOrCreateGoogleUser(profile)).resolves.toBe(
        existing,
      );
      // The settings row is never even read on the returning-member path.
      expect(mocks.platformSettings.get).not.toHaveBeenCalled();
    });

    it('rejects with registration_disabled before invite_required', async () => {
      // Registration being off beats every other new-account rejection: an
      // applicant with no invite should be told signups are closed, not that
      // they need an invite they cannot currently redeem anyway.
      mocks.platformSettings.get.mockResolvedValue({
        registrationEnabled: false,
      });
      mocks.users.findByGoogleId.mockResolvedValue(null);

      await expect(
        service.validateOrCreateGoogleUser({
          googleId: 'g-new',
          email: 'new@example.com',
          firstName: 'New',
          lastName: 'Person',
        }),
      ).rejects.toMatchObject({ reason: 'registration_disabled' });
    });
  });
});
