import { HttpStatus, VERSION_NEUTRAL } from '@nestjs/common';
import { VERSION_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { JoinRequestsService } from '../../membership/join-requests.service';
import { User } from '../../users/entities/user.entity';
import { AuthService } from '../auth.service';
import { CurrentUserData } from '../decorators/current-user.decorator';
import {
  SignupRejectedError,
  SignupRejectedReason,
} from '../errors/signup-rejected.error';
import { LOCKDOWN_EXEMPT_KEY } from '../../common/lockdown-exempt.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { EmailCodeController } from './email-code.controller';
import { EmailCodeRefusedError } from './email-code-refusal';
import { EmailCodeService } from './email-code.service';
import { EmailSignInChallengePurpose } from './email-sign-in-challenge.entity';

const FRONTEND = 'http://localhost:5173';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const EXPIRES_AT = new Date('2026-10-26T12:10:00.000Z');
const RESEND_AT = new Date('2026-10-26T12:01:00.000Z');
const WELL_FORMED_REQUESTER = 'A'.repeat(43);
const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const user = { id: 'u1' } as User;
const tokens = { accessToken: 'access-1', refreshToken: 'refresh-1' };
const issued = {
  challengeId: 'c1',
  expiresAt: EXPIRES_AT,
  resendAvailableAt: RESEND_AT,
};
const caller: CurrentUserData = {
  userId: 'u1',
  email: 'sam@example.com',
  status: 'active',
  role: 'member',
};

function makeRes() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

function makeReq(
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
): Request {
  return { cookies, headers } as unknown as Request;
}

function makeConfig() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'app.nodeEnv') return 'test';
      return undefined;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'app.frontendUrl') return FRONTEND;
      if (key === 'auth.jwtAccessTtlMs') return ACCESS_TTL_MS;
      if (key === 'auth.jwtRefreshTtlMs') return REFRESH_TTL_MS;
      throw new Error(`unexpected config key ${key}`);
    }),
  };
}

function build() {
  const emailCodes = {
    issueSignInChallenge: jest.fn().mockResolvedValue(issued),
    issueReauthChallenge: jest.fn().mockResolvedValue(issued),
    verifyChallenge: jest
      .fn()
      .mockResolvedValue({ email: 'sam@example.com', userId: null }),
    consumeChallenge: jest.fn().mockResolvedValue(true),
  };
  const authService = {
    signInWithVerifiedEmail: jest.fn().mockResolvedValue(user),
    revokeSessionForToken: jest.fn().mockResolvedValue(undefined),
    issueTokens: jest.fn().mockResolvedValue(tokens),
    mintReauthToken: jest.fn().mockResolvedValue({
      reauthToken: 'reauth-1',
      expiresAt: '2026-10-26T12:05:00.000Z',
    }),
  };
  const joinRequests = {
    recoverStatusTokenForVerifiedEmail: jest.fn().mockResolvedValue(null),
  };
  const config = makeConfig();
  const controller = new EmailCodeController(
    emailCodes as unknown as EmailCodeService,
    authService as unknown as AuthService,
    joinRequests as unknown as JoinRequestsService,
    config as unknown as ConfigService,
  );
  return { controller, emailCodes, authService, joinRequests };
}

function requesterCookieCall(res: ReturnType<typeof makeRes>) {
  return res.cookie.mock.calls.find(
    (call: unknown[]) => call[0] === 'email_code_requester',
  ) as [string, string, Record<string, unknown>] | undefined;
}

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

/** The global call order of a mock's call at `index`; throws when that call never happened. */
function callOrder(mock: jest.Mock, index = 0): number {
  const order = mock.mock.invocationCallOrder[index];
  if (order === undefined) throw new Error('mock was not called');
  return order;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('EmailCodeController.request', () => {
  it('request mints a requester cookie when none is presented and passes it to the service', async () => {
    const { controller, emailCodes } = build();
    const res = makeRes();

    const body = await controller.request(
      { email: 'Sam@Example.com', locale: 'pt' },
      makeReq(),
      res as unknown as Response,
    );

    const cookieCall = requesterCookieCall(res);
    expect(cookieCall).toBeDefined();
    const [, value, options] = cookieCall!;
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options).toMatchObject({ path: '/auth', httpOnly: true });
    expect(emailCodes.issueSignInChallenge).toHaveBeenCalledWith({
      rawEmail: 'Sam@Example.com',
      requesterKey: value,
      locale: 'pt',
      isRegistration: false,
    });
    expect(body).toEqual({
      challengeId: 'c1',
      expiresAt: '2026-10-26T12:10:00.000Z',
      resendAvailableAt: '2026-10-26T12:01:00.000Z',
    });
  });

  it('request reuses a well-formed requester cookie and replaces a malformed one', async () => {
    const { controller, emailCodes } = build();
    const reusedRes = makeRes();
    await controller.request(
      { email: 'sam@example.com', locale: 'en' },
      makeReq({ email_code_requester: WELL_FORMED_REQUESTER }),
      reusedRes as unknown as Response,
    );
    expect(requesterCookieCall(reusedRes)![1]).toBe(WELL_FORMED_REQUESTER);
    expect(emailCodes.issueSignInChallenge).toHaveBeenLastCalledWith(
      expect.objectContaining({ requesterKey: WELL_FORMED_REQUESTER }),
    );

    const replacedRes = makeRes();
    await controller.request(
      { email: 'sam@example.com', locale: 'en' },
      makeReq({ email_code_requester: 'short; path=/' }),
      replacedRes as unknown as Response,
    );
    const replacement = requesterCookieCall(replacedRes)![1];
    expect(replacement).not.toBe('short; path=/');
    expect(replacement).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(emailCodes.issueSignInChallenge).toHaveBeenLastCalledWith(
      expect.objectContaining({ requesterKey: replacement }),
    );
  });

  it('request passes isRegistration true through and treats an absent flag as false', async () => {
    const { controller, emailCodes } = build();
    await controller.request(
      { email: 'sam@example.com', locale: 'en', isRegistration: true },
      makeReq(),
      makeRes() as unknown as Response,
    );
    await controller.request(
      { email: 'sam@example.com', locale: 'en' },
      makeReq(),
      makeRes() as unknown as Response,
    );

    expect(emailCodes.issueSignInChallenge).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ isRegistration: true }),
    );
    expect(emailCodes.issueSignInChallenge).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ isRegistration: false }),
    );
  });

  it('request maps an unknown locale to en', async () => {
    const { controller, emailCodes } = build();
    await controller.request(
      { email: 'sam@example.com', locale: 'fr' },
      makeReq(),
      makeRes() as unknown as Response,
    );
    await controller.request(
      { email: 'sam@example.com' },
      makeReq(),
      makeRes() as unknown as Response,
    );
    expect(emailCodes.issueSignInChallenge).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ locale: 'en' }),
    );
    expect(emailCodes.issueSignInChallenge).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ locale: 'en' }),
    );
  });

  it('request leaves the requester cookie in place when the service refuses', async () => {
    const { controller, emailCodes } = build();
    emailCodes.issueSignInChallenge.mockRejectedValue(
      new EmailCodeRefusedError('resend_too_soon', {
        resendAvailableAt: RESEND_AT,
      }),
    );
    const res = makeRes();
    await expect(
      controller.request(
        { email: 'sam@example.com', locale: 'en' },
        makeReq(),
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(EmailCodeRefusedError);
    expect(requesterCookieCall(res)).toBeDefined();
  });
});

describe('EmailCodeController.verify', () => {
  const verifyBody = { challengeId: 'c1', code: '123456' };

  it("verify ends the browser's old session, sets auth cookies and answers the safe redirect", async () => {
    const { controller, emailCodes, authService } = build();
    const res = makeRes();

    const body = await controller.verify(
      { ...verifyBody, redirect: '/events' },
      makeReq(
        { email_code_requester: 'req-1', refresh_token: 'old-refresh' },
        { 'user-agent': 'UA' },
      ),
      res as unknown as Response,
    );

    expect(emailCodes.verifyChallenge).toHaveBeenCalledWith({
      challengeId: 'c1',
      code: '123456',
      purpose: EmailSignInChallengePurpose.SignIn,
      requesterKey: 'req-1',
    });
    expect(authService.revokeSessionForToken).toHaveBeenCalledWith(
      'old-refresh',
    );
    expect(authService.issueTokens).toHaveBeenCalledWith(user, 'UA');
    expect(callOrder(authService.revokeSessionForToken)).toBeLessThan(
      callOrder(authService.issueTokens),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'access-1',
      expect.objectContaining({ maxAge: ACCESS_TTL_MS, path: '/' }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'refresh-1',
      expect.objectContaining({ maxAge: REFRESH_TTL_MS, path: '/auth' }),
    );
    expect(body).toEqual({ redirectTo: 'http://localhost:5173/events' });
  });

  it('verify passes an empty requester key when the cookie is missing and issues no tokens when the service refuses', async () => {
    const { controller, emailCodes, authService } = build();
    emailCodes.verifyChallenge.mockRejectedValue(
      new EmailCodeRefusedError('code_incorrect', { attemptsLeft: 4 }),
    );
    const res = makeRes();

    await expect(
      controller.verify(verifyBody, makeReq(), res as unknown as Response),
    ).rejects.toBeInstanceOf(EmailCodeRefusedError);

    expect(emailCodes.verifyChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ requesterKey: '' }),
    );
    expect(authService.signInWithVerifiedEmail).not.toHaveBeenCalled();
    expect(emailCodes.consumeChallenge).not.toHaveBeenCalled();
    expect(authService.issueTokens).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('verify spends the code only after the sign-in succeeds', async () => {
    const { controller, emailCodes, authService } = build();
    await controller.verify(
      verifyBody,
      makeReq({ email_code_requester: 'req-1' }),
      makeRes() as unknown as Response,
    );

    expect(emailCodes.consumeChallenge).toHaveBeenCalledWith('c1');
    const consumedAt = callOrder(emailCodes.consumeChallenge);
    expect(callOrder(authService.signInWithVerifiedEmail)).toBeLessThan(
      consumedAt,
    );
    expect(consumedAt).toBeLessThan(callOrder(authService.issueTokens));
  });

  it('verify hands the signup fields to the sign-in', async () => {
    const { controller, authService } = build();
    await controller.verify(
      {
        ...verifyBody,
        invite: 'INV1',
        ageAttested: true,
        termsVersion: '2026-10',
        firstName: 'Sam',
        lastName: 'Rivera',
      },
      makeReq({ email_code_requester: 'req-1' }),
      makeRes() as unknown as Response,
    );
    expect(authService.signInWithVerifiedEmail).toHaveBeenCalledWith(
      'sam@example.com',
      {
        inviteCode: 'INV1',
        ageAttested: true,
        termsVersion: '2026-10',
        firstName: 'Sam',
        lastName: 'Rivera',
      },
    );
  });

  it.each<[string, Error]>([
    ['name_required', new SignupRejectedError('name_required')],
    ['invite_required', new SignupRejectedError('invite_required')],
    [
      'age_attestation_required',
      new SignupRejectedError('age_attestation_required'),
    ],
    ['invite_invalid', new SignupRejectedError('invite_invalid')],
    [
      'account_recovery_review',
      new EmailCodeRefusedError('account_recovery_review'),
    ],
  ])(
    'verify leaves the code open when a signup gate refuses (%s)',
    async (reason, refusal) => {
      const { controller, emailCodes, authService } = build();
      authService.signInWithVerifiedEmail.mockRejectedValue(refusal);
      const res = makeRes();

      const error = await refusalOf(
        controller.verify(
          verifyBody,
          makeReq({ email_code_requester: 'req-1' }),
          res as unknown as Response,
        ),
      );

      expect(error).toBeInstanceOf(EmailCodeRefusedError);
      expect((error as EmailCodeRefusedError).reason).toBe(reason);
      expect(emailCodes.consumeChallenge).not.toHaveBeenCalled();
      expect(authService.issueTokens).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    },
  );

  it('a correct code refused with name_required verifies again with firstName and succeeds', async () => {
    const { controller, emailCodes, authService } = build();
    authService.signInWithVerifiedEmail
      .mockRejectedValueOnce(new SignupRejectedError('name_required'))
      .mockResolvedValueOnce(user);
    const req = makeReq({ email_code_requester: 'req-1' });

    await expect(
      controller.verify(verifyBody, req, makeRes() as unknown as Response),
    ).rejects.toMatchObject({ reason: 'name_required' });

    const body = await controller.verify(
      { ...verifyBody, firstName: 'Sam', redirect: '/events' },
      req,
      makeRes() as unknown as Response,
    );

    const sameChallenge = {
      challengeId: 'c1',
      code: '123456',
      purpose: EmailSignInChallengePurpose.SignIn,
      requesterKey: 'req-1',
    };
    expect(emailCodes.verifyChallenge).toHaveBeenCalledTimes(2);
    expect(emailCodes.verifyChallenge).toHaveBeenNthCalledWith(
      1,
      sameChallenge,
    );
    expect(emailCodes.verifyChallenge).toHaveBeenNthCalledWith(
      2,
      sameChallenge,
    );
    expect(emailCodes.consumeChallenge).toHaveBeenCalledTimes(1);
    expect(authService.issueTokens).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ redirectTo: 'http://localhost:5173/events' });
  });

  it('verify answers code_already_used and issues no tokens when consumeChallenge returns false', async () => {
    const { controller, emailCodes, authService } = build();
    emailCodes.consumeChallenge.mockResolvedValue(false);
    const res = makeRes();

    const error = await refusalOf(
      controller.verify(
        verifyBody,
        makeReq({ email_code_requester: 'req-1' }),
        res as unknown as Response,
      ),
    );

    expect(error).toBeInstanceOf(EmailCodeRefusedError);
    expect((error as EmailCodeRefusedError).getResponse()).toEqual({
      reason: 'code_already_used',
      message: 'code_already_used',
    });
    expect((error as EmailCodeRefusedError).getStatus()).toBe(
      HttpStatus.BAD_REQUEST,
    );
    expect(authService.revokeSessionForToken).not.toHaveBeenCalled();
    expect(authService.issueTokens).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("verify answers invite_required with the applicant's status URL when they have a join request", async () => {
    const { controller, authService, joinRequests } = build();
    authService.signInWithVerifiedEmail.mockRejectedValue(
      new SignupRejectedError('invite_required'),
    );
    joinRequests.recoverStatusTokenForVerifiedEmail.mockResolvedValue('tok');

    const error = await refusalOf(
      controller.verify(
        verifyBody,
        makeReq({ email_code_requester: 'req-1' }),
        makeRes() as unknown as Response,
      ),
    );

    expect(
      joinRequests.recoverStatusTokenForVerifiedEmail,
    ).toHaveBeenCalledWith('sam@example.com');
    expect(error).toBeInstanceOf(EmailCodeRefusedError);
    expect((error as EmailCodeRefusedError).getResponse()).toEqual({
      reason: 'invite_required',
      message: 'invite_required',
      statusUrl: 'http://localhost:5173/auth/request-invite/status?token=tok',
    });
    expect((error as EmailCodeRefusedError).getStatus()).toBe(
      HttpStatus.FORBIDDEN,
    );
  });

  it('verify answers plain invite_required when there is no join request', async () => {
    const { controller, authService } = build();
    authService.signInWithVerifiedEmail.mockRejectedValue(
      new SignupRejectedError('invite_required'),
    );

    const error = await refusalOf(
      controller.verify(
        verifyBody,
        makeReq({ email_code_requester: 'req-1' }),
        makeRes() as unknown as Response,
      ),
    );

    expect((error as EmailCodeRefusedError).getResponse()).toEqual({
      reason: 'invite_required',
      message: 'invite_required',
    });
    expect((error as EmailCodeRefusedError).getStatus()).toBe(
      HttpStatus.FORBIDDEN,
    );
  });

  it.each<SignupRejectedReason>([
    'invite_invalid',
    'invite_email_mismatch',
    'invite_inviter_inactive',
    'age_attestation_required',
    'account_suppressed',
    'email_in_use',
    'registration_disabled',
    'name_required',
  ])(
    'verify maps every other SignupRejectedError to 403 with its reason (%s)',
    async (reason) => {
      const { controller, authService, joinRequests } = build();
      authService.signInWithVerifiedEmail.mockRejectedValue(
        new SignupRejectedError(reason),
      );

      const error = await refusalOf(
        controller.verify(
          verifyBody,
          makeReq({ email_code_requester: 'req-1' }),
          makeRes() as unknown as Response,
        ),
      );

      expect(error).toBeInstanceOf(EmailCodeRefusedError);
      expect((error as EmailCodeRefusedError).getResponse()).toEqual({
        reason,
        message: reason,
      });
      expect((error as EmailCodeRefusedError).getStatus()).toBe(
        HttpStatus.FORBIDDEN,
      );
      expect(
        joinRequests.recoverStatusTokenForVerifiedEmail,
      ).not.toHaveBeenCalled();
    },
  );
});

describe('EmailCodeController reauth routes', () => {
  it("reauth/request sends to the caller's own address and returns it", async () => {
    const { controller, emailCodes } = build();

    const body = await controller.reauthRequest(caller, { locale: 'de' });

    expect(emailCodes.issueReauthChallenge).toHaveBeenCalledWith({
      userId: 'u1',
      email: 'sam@example.com',
      locale: 'en',
    });
    expect(body).toEqual({
      challengeId: 'c1',
      expiresAt: '2026-10-26T12:10:00.000Z',
      resendAvailableAt: '2026-10-26T12:01:00.000Z',
      email: 'sam@example.com',
    });
  });

  it('reauth/verify checks a reauth challenge for the caller, then mints the token', async () => {
    const { controller, emailCodes, authService } = build();
    emailCodes.verifyChallenge.mockResolvedValue({
      email: 'sam@example.com',
      userId: 'u1',
    });

    const body = await controller.reauthVerify(caller, {
      challengeId: 'c1',
      code: '123456',
    });

    expect(emailCodes.verifyChallenge).toHaveBeenCalledWith({
      challengeId: 'c1',
      code: '123456',
      purpose: EmailSignInChallengePurpose.Reauth,
      requesterKey: 'user:u1',
      userId: 'u1',
    });
    expect(emailCodes.consumeChallenge).toHaveBeenCalledWith('c1');
    expect(authService.mintReauthToken).toHaveBeenCalledWith('u1');
    expect(callOrder(emailCodes.verifyChallenge)).toBeLessThan(
      callOrder(emailCodes.consumeChallenge),
    );
    expect(callOrder(emailCodes.consumeChallenge)).toBeLessThan(
      callOrder(authService.mintReauthToken),
    );
    expect(body).toEqual({
      reauthToken: 'reauth-1',
      expiresAt: '2026-10-26T12:05:00.000Z',
    });
  });

  it('reauth/verify answers code_already_used and mints nothing when consumeChallenge returns false', async () => {
    const { controller, emailCodes, authService } = build();
    emailCodes.consumeChallenge.mockResolvedValue(false);

    await expect(
      controller.reauthVerify(caller, { challengeId: 'c1', code: '123456' }),
    ).rejects.toMatchObject({ reason: 'code_already_used' });
    expect(authService.mintReauthToken).not.toHaveBeenCalled();
  });
});

describe('EmailCodeController routing', () => {
  it.each(['request', 'verify', 'reauthRequest', 'reauthVerify'] as const)(
    'every route is version neutral (%s)',
    (handler) => {
      expect(
        Reflect.getMetadata(
          VERSION_METADATA,
          EmailCodeController.prototype[handler],
        ),
      ).toBe(VERSION_NEUTRAL);
    },
  );

  it('request and verify are public, both reauth routes need a session, and the class is lockdown exempt', () => {
    const isPublic = (
      handler: 'request' | 'verify' | 'reauthRequest' | 'reauthVerify',
    ): unknown =>
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        EmailCodeController.prototype[handler],
      );

    expect(isPublic('request')).toBe(true);
    expect(isPublic('verify')).toBe(true);
    expect(isPublic('reauthRequest')).toBeUndefined();
    expect(isPublic('reauthVerify')).toBeUndefined();
    expect(Reflect.getMetadata(LOCKDOWN_EXEMPT_KEY, EmailCodeController)).toBe(
      true,
    );
  });
});
