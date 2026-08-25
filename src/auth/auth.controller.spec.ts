import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { encodeOAuthState } from './oauth-state';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { MediaCropService } from '../media-crops/media-crops.service';
import { UnderAgeDisclosureService } from './under-age-disclosure.service';

const FRONTEND = 'https://app.example.com';

interface AuthServiceMock {
  validateOrCreateGoogleUser: jest.Mock;
  issueTokens: jest.Mock;
  revokeSessionForToken: jest.Mock;
  rotateRefreshToken: jest.Mock;
  revokeRefreshToken: jest.Mock;
  revokeAllForUser: jest.Mock;
  suspensionInfoFor: jest.Mock;
  staffRolesFor: jest.Mock;
  verifyAccessToken: jest.Mock;
  mintReauthToken: jest.Mock;
}

function makeRes() {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn<void, [string]>(),
  };
}

function makeReq(partial: Record<string, unknown> = {}): Request {
  return {
    cookies: {},
    headers: {},
    query: {},
    ...partial,
  } as unknown as Request;
}

function makeConfig(nodeEnv = 'test', domain?: string) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'app.nodeEnv') return nodeEnv;
      if (key === 'auth.cookieDomain') return domain;
      return undefined;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'app.frontendUrl') return FRONTEND;
      // Cookie max-ages are derived from the configured JWT TTLs.
      if (key === 'auth.jwtAccessTtlMs') return 15 * 60 * 1000;
      if (key === 'auth.jwtRefreshTtlMs') return 30 * 24 * 60 * 60 * 1000;
      return 'x';
    }),
  };
}

function build(configNodeEnv = 'test', domain?: string) {
  const authService: AuthServiceMock = {
    validateOrCreateGoogleUser: jest.fn(),
    issueTokens: jest.fn(),
    revokeSessionForToken: jest.fn().mockResolvedValue(undefined),
    rotateRefreshToken: jest.fn(),
    revokeRefreshToken: jest.fn().mockResolvedValue(undefined),
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    suspensionInfoFor: jest
      .fn()
      .mockResolvedValue({ suspendedUntil: null, suspension: null }),
    staffRolesFor: jest.fn().mockResolvedValue([]),
    verifyAccessToken: jest.fn(),
    mintReauthToken: jest.fn(),
  };
  const usersService = {
    findByIdWithProfile: jest.fn(),
    findByGoogleId: jest.fn(),
  };
  const config = makeConfig(configNodeEnv, domain);
  const mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
  const underAgeDisclosure = {
    record: jest.fn().mockResolvedValue({
      disclosedAt: '2026-01-01T00:00:00.000Z',
      status: 'suspended',
    }),
  };
  const controller = new AuthController(
    authService as unknown as AuthService,
    usersService as unknown as UsersService,
    config as unknown as ConfigService,
    mediaCropService as unknown as MediaCropService,
    underAgeDisclosure as unknown as UnderAgeDisclosureService,
  );
  return {
    controller,
    authService,
    usersService,
    config,
    mediaCropService,
    underAgeDisclosure,
  };
}

describe('AuthController.googleCallback', () => {
  it('rejects a mismatched state nonce: redirects to invalid_state and clears the state cookie', async () => {
    const { controller, authService } = build();
    const req = makeReq({
      query: { state: encodeOAuthState({ nonce: 'server-nonce' }) },
      cookies: { oauth_state: 'attacker-nonce' },
      user: { googleId: 'g', email: 'a@b.c' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(res.clearCookie).toHaveBeenCalledWith(
      'oauth_state',
      expect.anything(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      `${FRONTEND}/auth/sign-in?error=invalid_state`,
    );
    expect(authService.validateOrCreateGoogleUser).not.toHaveBeenCalled();
  });

  it('rejects when the state carries no nonce (legacy/absent)', async () => {
    const { controller } = build();
    const req = makeReq({
      query: { state: encodeOAuthState({ redirect: '/feed' }) },
      cookies: { oauth_state: 'anything' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(res.redirect).toHaveBeenCalledWith(
      `${FRONTEND}/auth/sign-in?error=invalid_state`,
    );
  });

  it('happy path: matching nonce issues tokens with httpOnly/secure cookies and redirects to the safe path', async () => {
    const { controller, authService } = build('production');
    authService.validateOrCreateGoogleUser.mockResolvedValue({ id: 'u1' });
    authService.issueTokens.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
    });
    const req = makeReq({
      query: {
        state: encodeOAuthState({ nonce: 'match', redirect: '/feed' }),
      },
      cookies: { oauth_state: 'match' },
      user: { googleId: 'g', email: 'a@b.c' },
      headers: { 'user-agent': 'jest' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(res.clearCookie).toHaveBeenCalledWith(
      'oauth_state',
      expect.anything(),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'at',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'rt',
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
    expect(res.redirect).toHaveBeenCalledWith(`${FRONTEND}/feed`);
  });

  it('replaces the session this browser was already holding instead of stacking a second one', async () => {
    // Signing in overwrites the refresh cookie, so the previous session becomes
    // unreachable from here. Left live it sat in the member's device list for
    // the full 30-day refresh lifetime, and every re-login added another.
    const { controller, authService } = build();
    authService.validateOrCreateGoogleUser.mockResolvedValue({ id: 'u1' });
    authService.issueTokens.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
    });
    const req = makeReq({
      query: { state: encodeOAuthState({ nonce: 'match' }) },
      cookies: { oauth_state: 'match', refresh_token: 'previous-rt' },
      user: { googleId: 'g', email: 'a@b.c' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(authService.revokeSessionForToken).toHaveBeenCalledWith(
      'previous-rt',
    );
  });

  it('signs in cleanly when the browser holds no previous session', async () => {
    const { controller, authService } = build();
    authService.validateOrCreateGoogleUser.mockResolvedValue({ id: 'u1' });
    authService.issueTokens.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
    });
    const req = makeReq({
      query: { state: encodeOAuthState({ nonce: 'match' }) },
      cookies: { oauth_state: 'match' },
      user: { googleId: 'g', email: 'a@b.c' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(authService.revokeSessionForToken).toHaveBeenCalledWith(undefined);
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'rt',
      expect.anything(),
    );
  });

  it('maps SignupRejectedError to a frontend ?error redirect', async () => {
    const { controller, authService } = build();
    authService.validateOrCreateGoogleUser.mockRejectedValue(
      new SignupRejectedError('invite_required'),
    );
    const req = makeReq({
      query: { state: encodeOAuthState({ nonce: 'match' }) },
      cookies: { oauth_state: 'match' },
      user: { googleId: 'g', email: 'a@b.c' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(res.redirect).toHaveBeenCalledWith(
      `${FRONTEND}/auth/sign-in?error=invite_required`,
    );
  });
});

describe('AuthController.googleCallback (step-up reauth)', () => {
  it('mints a reauth token and redirects with it in the URL fragment when the returning Google account matches the current session', async () => {
    const { controller, authService, usersService } = build();
    authService.verifyAccessToken.mockResolvedValue({
      sub: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    });
    usersService.findByGoogleId.mockResolvedValue({ id: 'u1' });
    authService.mintReauthToken.mockResolvedValue({
      reauthToken: 'fresh-token',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
    const req = makeReq({
      query: {
        state: encodeOAuthState({
          nonce: 'match',
          redirect: '/settings',
          reauth: true,
        }),
      },
      cookies: { oauth_state: 'match', access_token: 'live-access-token' },
      user: { googleId: 'g', email: 'a@b.c' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(authService.verifyAccessToken).toHaveBeenCalledWith(
      'live-access-token',
    );
    expect(usersService.findByGoogleId).toHaveBeenCalledWith('g');
    expect(authService.mintReauthToken).toHaveBeenCalledWith('u1');
    // Never touches ordinary sign-in: no account created/updated, no session
    // cookies set.
    expect(authService.validateOrCreateGoogleUser).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
    const redirectedTo = new URL(res.redirect.mock.calls[0]![0]);
    expect(redirectedTo.origin + redirectedTo.pathname).toBe(
      `${FRONTEND}/settings`,
    );
    const hashParams = new URLSearchParams(redirectedTo.hash.slice(1));
    expect(hashParams.get('reauthToken')).toBe('fresh-token');
    expect(hashParams.get('reauthExpiresAt')).toBe('2026-01-01T00:05:00.000Z');
  });

  it('fails closed when there is no live session to step up (missing/expired access token)', async () => {
    const { controller, authService, usersService } = build();
    authService.verifyAccessToken.mockResolvedValue(null);
    const req = makeReq({
      query: {
        state: encodeOAuthState({
          nonce: 'match',
          redirect: '/settings',
          reauth: true,
        }),
      },
      cookies: { oauth_state: 'match' }, // no access_token cookie
      user: { googleId: 'g', email: 'a@b.c' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(usersService.findByGoogleId).not.toHaveBeenCalled();
    expect(authService.mintReauthToken).not.toHaveBeenCalled();
    const redirectedTo = new URL(res.redirect.mock.calls[0]![0]);
    expect(redirectedTo.origin + redirectedTo.pathname).toBe(
      `${FRONTEND}/settings`,
    );
    expect(
      new URLSearchParams(redirectedTo.hash.slice(1)).get('reauthError'),
    ).toBe('reauth_failed');
  });

  it('fails closed when the Google account that logged back in belongs to a DIFFERENT member than the current session', async () => {
    const { controller, authService, usersService } = build();
    authService.verifyAccessToken.mockResolvedValue({
      sub: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    });
    // The Google account that just re-authenticated belongs to someone else.
    usersService.findByGoogleId.mockResolvedValue({ id: 'u2' });
    const req = makeReq({
      query: {
        state: encodeOAuthState({
          nonce: 'match',
          redirect: '/settings',
          reauth: true,
        }),
      },
      cookies: { oauth_state: 'match', access_token: 'live-access-token' },
      user: { googleId: 'someone-elses-google-id', email: 'other@b.c' },
    });
    const res = makeRes();

    await controller.googleCallback(req, res as unknown as Response);

    expect(authService.mintReauthToken).not.toHaveBeenCalled();
    const redirectedTo = new URL(res.redirect.mock.calls[0]![0]);
    expect(
      new URLSearchParams(redirectedTo.hash.slice(1)).get('reauthError'),
    ).toBe('reauth_failed');
  });
});

describe('AuthController.refresh', () => {
  it('missing refresh cookie: clears cookies and throws 401', async () => {
    const { controller } = build();
    const res = makeRes();
    await expect(
      controller.refresh(makeReq(), res as unknown as Response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.anything(),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.anything(),
    );
  });

  it('rotation failure: clears cookies and rethrows so the client stops looping', async () => {
    const { controller, authService } = build();
    authService.rotateRefreshToken.mockRejectedValue(
      new UnauthorizedException('reuse'),
    );
    const res = makeRes();
    await expect(
      controller.refresh(
        makeReq({ cookies: { refresh_token: 'raw' } }),
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.anything(),
    );
  });

  it('success: sets rotated cookies and returns { ok: true }', async () => {
    const { controller, authService } = build();
    authService.rotateRefreshToken.mockResolvedValue({
      accessToken: 'at2',
      refreshToken: 'rt2',
    });
    const res = makeRes();
    const out = await controller.refresh(
      makeReq({ cookies: { refresh_token: 'raw' } }),
      res as unknown as Response,
    );
    expect(out).toEqual({ ok: true });
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'at2',
      expect.objectContaining({ httpOnly: true }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'rt2',
      expect.anything(),
    );
  });

  it('non-production cookies are not marked secure', async () => {
    const { controller, authService } = build('test');
    authService.rotateRefreshToken.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
    });
    const res = makeRes();
    await controller.refresh(
      makeReq({ cookies: { refresh_token: 'raw' } }),
      res as unknown as Response,
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'at',
      expect.objectContaining({ secure: false }),
    );
  });
});

describe('AuthController.logout', () => {
  it('revokes the refresh row and clears auth + csrf cookies', async () => {
    const { controller, authService } = build();
    const res = makeRes();
    const out = await controller.logout(
      makeReq({ cookies: { refresh_token: 'raw' } }),
      res as unknown as Response,
    );
    expect(authService.revokeRefreshToken).toHaveBeenCalledWith('raw');
    expect(res.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.anything(),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.anything(),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'csrf_token',
      expect.objectContaining({ path: '/' }),
    );
    expect(out).toEqual({ ok: true });
  });

  it('still logs out (clears cookies, ok) when no refresh cookie is present', async () => {
    const { controller, authService } = build();
    const res = makeRes();
    const out = await controller.logout(makeReq(), res as unknown as Response);
    expect(authService.revokeRefreshToken).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith(
      'csrf_token',
      expect.objectContaining({ path: '/' }),
    );
    expect(out).toEqual({ ok: true });
  });

  it('swallows a revoke error and still returns ok', async () => {
    const { controller, authService } = build();
    authService.revokeRefreshToken.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    const out = await controller.logout(
      makeReq({ cookies: { refresh_token: 'raw' } }),
      res as unknown as Response,
    );
    expect(out).toEqual({ ok: true });
    expect(res.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.anything(),
    );
  });
});

describe('AuthController.logoutAll', () => {
  it('revokes every live token for the current user and clears cookies', async () => {
    const { controller, authService } = build();
    const res = makeRes();
    const out = await controller.logoutAll(
      { userId: 'u1', email: 'a@b.c', status: 'active', role: 'member' },
      res as unknown as Response,
    );
    expect(authService.revokeAllForUser).toHaveBeenCalledWith('u1');
    expect(res.clearCookie).toHaveBeenCalledWith(
      'csrf_token',
      expect.objectContaining({ path: '/' }),
    );
    expect(out).toEqual({ ok: true });
  });
});

describe('AuthController.underEighteenDisclosure', () => {
  it("records the disclosure and clears this device's cookies", async () => {
    const { controller, underAgeDisclosure } = build();
    const res = makeRes();
    const out = await controller.underEighteenDisclosure(
      { userId: 'u1', email: 'a@b.c', status: 'active', role: 'member' },
      res as unknown as Response,
    );
    expect(underAgeDisclosure.record).toHaveBeenCalledWith('u1');
    expect(res.clearCookie).toHaveBeenCalledWith(
      'csrf_token',
      expect.objectContaining({ path: '/' }),
    );
    expect(out).toEqual({
      disclosedAt: '2026-01-01T00:00:00.000Z',
      status: 'suspended',
    });
  });
});

describe('AuthController.me', () => {
  beforeEach(() => {
    resetImageUrlBaseForTesting();
    setImageUrlBase('https://api.test');
  });
  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('returns the current user with profile', async () => {
    const { controller, usersService } = build();
    usersService.findByIdWithProfile.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
      profile: {
        slug: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        pronouns: 'she/her',
        avatarUrl: null,
        // Internal columns the hand-mapped shape must NOT echo back.
        verifiedBy: 'admin-1',
        vouchCount: 3,
      },
    });
    const out = await controller.me({
      userId: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    });
    expect(out).toEqual({
      id: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
      // NULL for accounts created before the 18+ gate shipped (this fixture has
      // no ageAttestedAt), surfaced as a nullable ISO string.
      ageAttestedAt: null,
      // Likewise null for a fixture with no onboardedAt.
      onboardedAt: null,
      // Hand-mapped allowlist, not a spread of the entity: `verifiedBy` and
      // `vouchCount` above are deliberately absent.
      profile: {
        slug: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        pronouns: 'she/her',
        avatarUrl: null,
        avatarCrop: undefined,
      },
      // Mocked `staffRolesFor` — no staff-role grants for this fixture.
      staffRoles: [],
      // Suspension detail — null for an active member (mocked `suspensionInfoFor`).
      suspendedUntil: null,
      suspension: null,
    });
  });

  it('resolves an uploaded avatar STORAGE KEY into a fetchable /files URL', async () => {
    const { controller, usersService } = build();
    const key =
      'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg';
    usersService.findByIdWithProfile.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
      profile: {
        slug: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        pronouns: null,
        avatarUrl: key,
      },
    });
    const out = await controller.me({
      userId: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    });
    // The bare key would render as a broken relative image on the frontend; it
    // must come back as an absolute URL to the authorizing /files route.
    expect(out.profile).toEqual({
      slug: 'ada',
      firstName: 'Ada',
      lastName: 'Lovelace',
      pronouns: null,
      avatarUrl: `https://api.test/files/${key}`,
      avatarCrop: undefined,
    });
  });

  it('passes an absolute Google avatar URL through untouched', async () => {
    const { controller, usersService } = build();
    const googleUrl = 'https://lh3.googleusercontent.com/a/abc=s96-c';
    usersService.findByIdWithProfile.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
      profile: {
        slug: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        pronouns: null,
        avatarUrl: googleUrl,
      },
    });
    const out = await controller.me({
      userId: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    });
    expect((out.profile as { avatarUrl: string | null }).avatarUrl).toBe(
      googleUrl,
    );
  });

  it('throws 401 when the backing user no longer exists', async () => {
    const { controller, usersService } = build();
    usersService.findByIdWithProfile.mockResolvedValue(null);
    await expect(
      controller.me({
        userId: 'gone',
        email: 'a@b.c',
        status: 'active',
        role: 'member',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
