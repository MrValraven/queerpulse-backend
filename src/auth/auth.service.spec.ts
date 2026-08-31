import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { AccountReauthToken } from '../account/entities/account-reauth-token.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from '../account/entities/deletion-request.entity';
import { EmailSuppression } from '../account/entities/email-suppression.entity';
import { InvitesService } from '../membership/invites.service';
import { VouchService } from '../vouch/vouch.service';
import { ConnectionsService } from '../connections/connections.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { RefreshToken } from './entities/refresh-token.entity';
import { IdentityRelinkCandidate } from './entities/identity-relink-candidate.entity';
import { SECURITY_NEW_SIGN_IN } from './security.events';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

interface RepoMock {
  findOne: jest.Mock;
  update: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  /** Backs `recogniseDevice`'s distinct-device-label read on the sign-in path. */
  createQueryBuilder: jest.Mock;
}
interface JwtMock {
  verifyAsync: jest.Mock;
  signAsync: jest.Mock;
  decode: jest.Mock;
}
interface UsersMock {
  findById: jest.Mock;
  findByIdWithEmail: jest.Mock;
  findByGoogleId: jest.Mock;
  createGoogleUser: jest.Mock;
  findIdByEmail: jest.Mock;
}

function buildMocks() {
  const repo: RepoMock = {
    findOne: jest.fn(),
    // Every update resolves an UpdateResult-shaped object with `affected`.
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((v: Record<string, unknown>) => v),
    save: jest.fn((v: Record<string, unknown>) =>
      Promise.resolve({
        id: 'new-row',
        ...v,
      }),
    ),
    // `recogniseDevice` asks for this member's distinct stored device labels
    // before a sign-in mints its family. Empty by default, which is the
    // "no device history on record" case: no alert is emitted, so the tests
    // below exercise the token path without also asserting notification
    // behaviour. A test that wants the alert sets `getRawMany` itself.
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    })),
  };
  const jwt: JwtMock = {
    verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1' }),
    signAsync: jest.fn().mockResolvedValue('signed'),
    decode: jest.fn().mockReturnValue({ exp: 9999999999 }),
  };
  const activeUser = {
    id: 'u1',
    email: 'a@b.c',
    status: 'active',
    role: 'member',
  };
  const users: UsersMock = {
    findById: jest.fn().mockResolvedValue(activeUser),
    // Rotation loads the user via findByIdWithEmail (the new access token embeds
    // an email claim, and User.email is select:false).
    findByIdWithEmail: jest.fn().mockResolvedValue(activeUser),
    findByGoogleId: jest.fn(),
    createGoogleUser: jest.fn(),
    // Signup's "a different Google subject already holds this email" guard.
    // Nobody holds it by default, so signup is unaffected unless a test says
    // so; a test that returns an id gets the PRD-06 relink-candidate path.
    findIdByEmail: jest.fn().mockResolvedValue(null),
  };
  // The transaction manager exposes getRepository so the atomic rotation can
  // run its conditional claim + insert through the same (mock) repo, plus a
  // direct `update` for the reactivate-on-sign-in path (which updates `User`
  // and `AccountDeactivation` by entity class rather than via a repository).
  const managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const dataSource = {
    transaction: jest.fn((cb: (m: unknown) => unknown) =>
      cb({ getRepository: () => repo, update: managerUpdate }),
    ),
  };
  const invites = {
    validateInviteForSignup: jest.fn(),
    claimInvite: jest.fn().mockResolvedValue(undefined),
  };
  // Auto-vouch on personal-invite signup. Returns true (a row was inserted) by
  // default; tests for the non-personal path assert it is never called.
  const vouch = {
    createVouchInTransaction: jest.fn().mockResolvedValue(true),
  };
  // The inviter and the personally-invited new member become mutually connected
  // inside the signup transaction (personal invites only).
  const connections = {
    createConnectionInTransaction: jest.fn().mockResolvedValue(undefined),
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
  // Write-side — `mintReauthToken`'s target (the step-up reauth OAuth round
  // trip). `save` echoes back whatever it was given, same pattern as `repo`.
  const reauthTokens = {
    save: jest.fn((v: Record<string, unknown>) =>
      Promise.resolve({ id: 'reauth-row', ...v }),
    ),
  };
  // Read-side only — `suspensionInfoFor` reads the member's latest
  // moderation-outcome notification for the reason. Empty by default.
  const notifications = {
    findOne: jest
      .fn<Promise<Pick<Notification, 'payload'> | null>, [unknown]>()
      .mockResolvedValue(null),
  };
  // Read-side only — `staffRolesFor` reads the caller's staff-role grants.
  // Empty by default.
  const staffRoles = { find: jest.fn().mockResolvedValue([]) };
  // Read-side only, one column — the new-device sign-in alert's own switch.
  // `null` is the no-row case, which defaults the switch ON.
  const memberPreferences = { findOne: jest.fn().mockResolvedValue(null) };
  // Registration kill switch — on by default, so signup is unaffected unless
  // a test explicitly turns it off.
  const platformSettings = {
    get: jest.fn().mockResolvedValue({ registrationEnabled: true }),
  };
  // Write-side (PRD-06) — `recordRelinkCandidate` inserts through a query
  // builder and trims through `find`/`update`. The insert reports "already
  // existed" by default (no identifier), which is the branch that only bumps
  // the attempt counter.
  const relinkCandidates = {
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => ({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ identifiers: [] }),
    })),
  };
  return {
    repo,
    jwt,
    users,
    dataSource,
    managerUpdate,
    invites,
    vouch,
    connections,
    events,
    suppressions,
    deactivations,
    deletionRequests,
    reauthTokens,
    notifications,
    staffRoles,
    memberPreferences,
    platformSettings,
    relinkCandidates,
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
      { provide: VouchService, useValue: mocks.vouch },
      { provide: ConnectionsService, useValue: mocks.connections },
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
        provide: getRepositoryToken(AccountReauthToken),
        useValue: mocks.reauthTokens,
      },
      {
        // Read-side only — backs `suspensionInfoFor`'s latest-outcome lookup.
        provide: getRepositoryToken(Notification),
        useValue: mocks.notifications,
      },
      {
        // Read-side only — backs `staffRolesFor`'s grant lookup.
        provide: getRepositoryToken(UserStaffRole),
        useValue: mocks.staffRoles,
      },
      {
        // Read-side only — backs `loginAlertsEnabled`'s single-column read.
        provide: getRepositoryToken(MemberPreferences),
        useValue: mocks.memberPreferences,
      },
      {
        // Write-side (PRD-06) — backs `recordRelinkCandidate`. The signup tests
        // never reach it (`findIdByEmail` resolves null by default), so a bare
        // repo mock is enough to satisfy injection.
        provide: getRepositoryToken(IdentityRelinkCandidate),
        useValue: mocks.relinkCandidates,
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
    familyId: 'fam-1',
    sessionStartedAt: new Date('2026-08-01T10:00:00Z'),
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
    // Rotation carries the SAME session forward, so the replacement access
    // token names the same family the device has held since it signed in.
    const [accessClaims] = mocks.jwt.signAsync.mock.calls[0] as [
      { sid?: string },
    ];
    expect(accessClaims.sid).toBe('fam-1');
    expect(mocks.repo.findOne).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw-token') },
    });
    // Rotation happens inside a single transaction.
    expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
    // The claim is conditional (only the un-revoked row) and links replaced_by.
    expect(mocks.repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'old-row' }),
      expect.objectContaining({
        revokedAt: expect.any(Date) as unknown,
        replacedBy: expect.any(String) as unknown,
      }),
    );
    // A brand-new row was persisted with the pre-generated id used in the claim.
    const updateArguments = mocks.repo.update.mock.calls[0] as [
      unknown,
      { replacedBy: string },
    ];
    const claimReplacement = updateArguments[1].replacedBy;
    expect(mocks.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: claimReplacement, userId: 'u1' }),
    );
    expect(mocks.repo.save).toHaveBeenCalledTimes(1);
  });

  it('carries the session family and start time through the rotation', async () => {
    // The row is a credential; the SESSION is the family. Minting a new family
    // here would show the member's own device as a brand-new sign-in on the
    // security page every 15 minutes.
    mocks.repo.findOne.mockResolvedValue(liveRow());

    await service.rotateRefreshToken('raw-token', 'agent');

    expect(mocks.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'fam-1',
        sessionStartedAt: new Date('2026-08-01T10:00:00Z'),
      }),
    );
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
      expect.objectContaining({ revokedAt: expect.any(Date) as unknown }),
    );
    expect(mocks.dataSource.transaction).not.toHaveBeenCalled();
    expect(mocks.repo.save).not.toHaveBeenCalled();
    // A compromise signal — the member's live socket must be dropped too.
    expect(mocks.events.emit).toHaveBeenCalledWith('user.session.revoked', {
      userId: 'u1',
    });
  });

  it('absorbs a rotation race inside the grace window: issues a fresh pair, keeps the family', async () => {
    // Rotated one second ago BY A ROTATION (`replacedBy` set) — the signature
    // of the member's other tab/PWA refreshing the same expiring cookie, not
    // of a stolen token replayed later.
    mocks.repo.findOne.mockResolvedValue({
      ...liveRow(),
      revokedAt: new Date(Date.now() - 1_000),
      replacedBy: 'newer-row',
    });

    const result = await service.rotateRefreshToken('raw-token', 'agent');

    expect(result).toEqual({ accessToken: 'signed', refreshToken: 'signed' });
    // No family revocation, and crucially no socket-dropping sign-out event.
    expect(mocks.events.emit).not.toHaveBeenCalledWith('user.session.revoked', {
      userId: 'u1',
    });
    // The replacement joins the SAME family. Starting a new one stranded the
    // race winner's still-live row as a second family, so one browser showed up
    // twice in the member's device list and stayed there for 30 days.
    expect(mocks.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'fam-1',
        sessionStartedAt: new Date('2026-08-01T10:00:00Z'),
      }),
    );
  });

  it('still treats a token revoked long ago as reuse', async () => {
    mocks.repo.findOne.mockResolvedValue({
      ...liveRow(),
      revokedAt: new Date(Date.now() - 60_000),
      replacedBy: 'newer-row',
    });

    await expect(
      service.rotateRefreshToken('raw-token', 'agent'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
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
      expect.objectContaining({ revokedAt: expect.any(Date) as unknown }),
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
    mocks.users.findByIdWithEmail.mockResolvedValue(null);
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

describe('AuthService.issueTokens / revokeSessionForToken', () => {
  let service: AuthService;
  let mocks: ReturnType<typeof buildMocks>;

  const activeUser = {
    id: 'u1',
    email: 'a@b.c',
    status: 'active',
    role: 'member',
  } as unknown as Parameters<AuthService['issueTokens']>[0];

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('issueTokens starts a NEW family for a sign-in', async () => {
    await service.issueTokens(activeUser, 'agent');
    const [created] = mocks.repo.create.mock.calls[0] as [
      { familyId: string; sessionStartedAt: Date },
    ];
    expect(created.familyId).toEqual(expect.any(String));
    expect(created.sessionStartedAt).toBeInstanceOf(Date);
  });

  // Every access token has to name its session, or `JwtStrategy.validate`
  // cannot tell a revoked device from a live one and `/account/sessions` cannot
  // tell the caller which listed device is the one in their hand.
  it('issueTokens signs the family id into the access token as `sid`', async () => {
    await service.issueTokens(activeUser, 'agent');
    const [created] = mocks.repo.create.mock.calls[0] as [{ familyId: string }];
    const [accessClaims] = mocks.jwt.signAsync.mock.calls[0] as [
      { sub: string; sid?: string },
    ];
    expect(accessClaims.sid).toBe(created.familyId);
  });

  // The sign-in alert (ID-06). Three cases, and the two SILENT ones are the
  // ones worth pinning: a security alert that fires on a member's own everyday
  // laptop is an alert they learn to swipe away.
  it('issueTokens says nothing when the device label is already on record', async () => {
    mocks.repo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ deviceLabel: 'Chrome on macOS' }]),
    });

    await service.issueTokens(
      activeUser,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );

    expect(mocks.events.emit).not.toHaveBeenCalledWith(
      SECURITY_NEW_SIGN_IN,
      expect.anything(),
    );
  });

  it('issueTokens says nothing when the member has no device history at all', async () => {
    // The default mock returns no labels: a first-ever session, or a member
    // whose whole history predates the `device_label` column. Neither is
    // something to wake anybody up about.
    await service.issueTokens(activeUser, 'agent');

    expect(mocks.events.emit).not.toHaveBeenCalledWith(
      SECURITY_NEW_SIGN_IN,
      expect.anything(),
    );
  });

  it('issueTokens alerts on a device label the member has not used before', async () => {
    mocks.repo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ deviceLabel: 'Safari on iPhone' }]),
    });

    await service.issueTokens(
      activeUser,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );

    expect(mocks.events.emit).toHaveBeenCalledWith(
      SECURITY_NEW_SIGN_IN,
      expect.objectContaining({
        userId: 'u1',
        deviceLabel: 'Chrome on Windows',
      }),
    );
  });

  it('issueTokens honours the member turning login alerts off', async () => {
    mocks.repo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ deviceLabel: 'Safari on iPhone' }]),
    });
    mocks.memberPreferences.findOne.mockResolvedValue({
      userId: 'u1',
      loginAlertsEnabled: false,
    });

    await service.issueTokens(
      activeUser,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );

    expect(mocks.events.emit).not.toHaveBeenCalledWith(
      SECURITY_NEW_SIGN_IN,
      expect.anything(),
    );
  });

  it('revokeSessionForToken revokes the family the presented cookie belongs to', async () => {
    // The sign-in path calls this with the cookie it is about to overwrite.
    // Without it, every re-login left the previous session live for the full
    // 30-day refresh lifetime and listed as another signed-in device.
    mocks.repo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      familyId: 'fam-1',
      revokedAt: null,
    });

    await service.revokeSessionForToken('raw-token');

    expect(mocks.repo.update).toHaveBeenCalledWith(
      { familyId: 'fam-1', revokedAt: expect.anything() as unknown },
      expect.objectContaining({ revokedAt: expect.any(Date) as unknown }),
    );
  });

  it('revokeSessionForToken never drops the member other devices sockets', async () => {
    mocks.repo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      familyId: 'fam-1',
      revokedAt: null,
    });

    await service.revokeSessionForToken('raw-token');

    // Signing in on the laptop must not kick the phone off chat.
    expect(mocks.events.emit).not.toHaveBeenCalledWith('user.session.revoked', {
      userId: 'u1',
    });
  });

  it('revokeSessionForToken is a no-op without a cookie (a first sign-in)', async () => {
    await service.revokeSessionForToken(undefined);
    expect(mocks.repo.findOne).not.toHaveBeenCalled();
    expect(mocks.repo.update).not.toHaveBeenCalled();
  });

  it('revokeSessionForToken is a no-op for an unknown token', async () => {
    mocks.repo.findOne.mockResolvedValue(null);
    await expect(
      service.revokeSessionForToken('raw-token'),
    ).resolves.toBeUndefined();
    expect(mocks.repo.update).not.toHaveBeenCalled();
  });
});

describe('AuthService.revokeRefreshToken / revokeAllForUser', () => {
  let service: AuthService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('revokeRefreshToken looks up the row by hash, revokes its family, and drops the session', async () => {
    mocks.repo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      familyId: 'fam-1',
      revokedAt: null,
    });
    await service.revokeRefreshToken('raw-token');
    expect(mocks.repo.findOne).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw-token') },
    });
    // The FAMILY, so a sibling row stranded by a rotation race dies with it
    // rather than keeping this device listed as signed in.
    expect(mocks.repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'fam-1' }),
      expect.objectContaining({ revokedAt: expect.any(Date) as unknown }),
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
      familyId: 'fam-1',
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
      expect.objectContaining({ revokedAt: expect.any(Date) as unknown }),
    );
    expect(mocks.events.emit).toHaveBeenCalledWith('user.session.revoked', {
      userId: 'u1',
    });
  });
});

describe('AuthService.mintReauthToken', () => {
  let service: AuthService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('stores only the SHA-256 hash of the token, never the plaintext', async () => {
    const result = await service.mintReauthToken('u1');

    // The row persisted to the reauth store holds the HASH, so a leaked table
    // yields no usable step-up tokens (finding L1).
    expect(mocks.reauthTokens.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        token: sha256(result.reauthToken),
      }),
    );
    // The plaintext handed back to the caller is NOT what we stored.
    const savedArguments = mocks.reauthTokens.save.mock.calls[0] as [
      { token: string },
    ];
    expect(savedArguments[0].token).not.toEqual(result.reauthToken);
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
        expect.objectContaining({ reactivatedAt: expect.any(Date) as unknown }),
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
      personal: true,
      vouch: 'you belong here',
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
        ageAttestedAt: expect.any(Date) as unknown,
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

  it('auto-vouches the inviter for the new member on a personal invite', async () => {
    mocks.users.findByGoogleId.mockResolvedValue(null);
    mocks.invites.validateInviteForSignup.mockResolvedValue({
      inviteId: 'inv-1',
      inviterId: 'inviter-1',
      personal: true,
      vouch: 'you belong here',
    });
    mocks.users.createGoogleUser.mockResolvedValue({
      id: 'new-user',
      status: UserStatus.Active,
    });

    await service.validateOrCreateGoogleUser(profile, 'CODE', attested);

    // The inviter vouches for the new member, carrying the invite's vouch note.
    expect(mocks.vouch.createVouchInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'inviter-1',
      'new-user',
      'you belong here',
    );
    // And the vouch is announced only after the transaction commits.
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'vouch.created',
      expect.objectContaining({
        voucherId: 'inviter-1',
        voucheeId: 'new-user',
      }),
    );
  });

  it('does NOT auto-vouch when the invite is not personal (admin approval)', async () => {
    mocks.users.findByGoogleId.mockResolvedValue(null);
    mocks.invites.validateInviteForSignup.mockResolvedValue({
      inviteId: 'inv-1',
      inviterId: 'admin-1',
      personal: false,
      vouch: null,
    });
    mocks.users.createGoogleUser.mockResolvedValue({
      id: 'new-user',
      status: UserStatus.Active,
    });

    await service.validateOrCreateGoogleUser(profile, 'CODE', attested);

    expect(mocks.vouch.createVouchInTransaction).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalledWith(
      'vouch.created',
      expect.anything(),
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

describe('AuthService.suspensionInfoFor', () => {
  let service: AuthService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  const asUser = (partial: Partial<User>): User => partial as User;

  it('returns nulls for an active member and never queries notifications', async () => {
    const info = await service.suspensionInfoFor(
      asUser({ id: 'u1', status: UserStatus.Active, suspendedUntil: null }),
    );

    expect(info).toEqual({ suspendedUntil: null, suspension: null });
    expect(mocks.notifications.findOne).not.toHaveBeenCalled();
  });

  it('returns the expiry + reason from the latest moderation-outcome notification', async () => {
    const until = new Date('2026-09-01T00:00:00.000Z');
    mocks.notifications.findOne.mockResolvedValue({
      payload: { note: 'Seven days for harassment.', reasonCode: 'harassment' },
    });

    const info = await service.suspensionInfoFor(
      asUser({ id: 'u1', status: UserStatus.Suspended, suspendedUntil: until }),
    );

    expect(mocks.notifications.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
        }) as Partial<Notification>,
        order: { createdAt: 'DESC' },
      }),
    );
    expect(info).toEqual({
      suspendedUntil: until.toISOString(),
      suspension: {
        note: 'Seven days for harassment.',
        reasonCode: 'harassment',
      },
    });
  });

  it('reports a permanent ban as suspended with a null expiry', async () => {
    mocks.notifications.findOne.mockResolvedValue({
      payload: { note: 'Permanent removal.', reasonCode: 'harassment' },
    });

    const info = await service.suspensionInfoFor(
      asUser({ id: 'u1', status: UserStatus.Suspended, suspendedUntil: null }),
    );

    expect(info.suspendedUntil).toBeNull();
    expect(info.suspension).toEqual({
      note: 'Permanent removal.',
      reasonCode: 'harassment',
    });
  });

  it('falls back to a null reason when no moderation-outcome notification exists', async () => {
    const until = new Date('2026-09-01T00:00:00.000Z');
    mocks.notifications.findOne.mockResolvedValue(null);

    const info = await service.suspensionInfoFor(
      asUser({ id: 'u1', status: UserStatus.Suspended, suspendedUntil: until }),
    );

    expect(info).toEqual({
      suspendedUntil: until.toISOString(),
      suspension: null,
    });
  });
});
