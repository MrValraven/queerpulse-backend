import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { encodeOAuthState } from './oauth-state';

const FRONTEND = 'https://app.example.com';

interface AuthServiceMock {
  validateOrCreateGoogleUser: jest.Mock;
  issueTokens: jest.Mock;
  rotateRefreshToken: jest.Mock;
  revokeRefreshToken: jest.Mock;
  revokeAllForUser: jest.Mock;
}

function makeRes() {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
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
      return 'x';
    }),
  };
}

function build(configNodeEnv = 'test', domain?: string) {
  const authService: AuthServiceMock = {
    validateOrCreateGoogleUser: jest.fn(),
    issueTokens: jest.fn(),
    rotateRefreshToken: jest.fn(),
    revokeRefreshToken: jest.fn().mockResolvedValue(undefined),
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };
  const usersService = { findByIdWithProfile: jest.fn() };
  const config = makeConfig(configNodeEnv, domain);
  const controller = new AuthController(
    authService as unknown as AuthService,
    usersService as unknown as UsersService,
    config as unknown as ConfigService,
  );
  return { controller, authService, usersService, config };
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
      `${FRONTEND}/login?error=invalid_state`,
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
      `${FRONTEND}/login?error=invalid_state`,
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
      `${FRONTEND}/login?error=invite_required`,
    );
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
    const out = await controller.logout(
      makeReq(),
      res as unknown as Response,
    );
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

describe('AuthController.me', () => {
  it('returns the current user with profile', async () => {
    const { controller, usersService } = build();
    usersService.findByIdWithProfile.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
      profile: { displayName: 'Ada' },
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
      profile: { displayName: 'Ada' },
    });
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
