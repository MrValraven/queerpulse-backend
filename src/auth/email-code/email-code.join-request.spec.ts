import {
  ConflictException,
  ForbiddenException,
  Logger,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { VERSION_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { LOCKDOWN_EXEMPT_KEY } from '../../common/lockdown-exempt.decorator';
import { JoinRequestsService } from '../../membership/join-requests.service';
import { AuthService } from '../auth.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { VerifyJoinRequestEmailCodeDto } from './dto/join-request-email-code.dto';
import { EmailCodeController } from './email-code.controller';
import { EmailCodeRefusedError } from './email-code-refusal';
import { EmailCodeService } from './email-code.service';
import { EmailSignInChallengePurpose } from './email-sign-in-challenge.entity';

/**
 * SEC-10. A join request is filed only for an address the applicant proved
 * they hold with an email code, and nothing an unverified caller sees says
 * whether that address already applied, was declined or is cooling down.
 */

const REQUESTER = 'B'.repeat(43);
const TRUSTED_TOKEN = `1795000000.${'T'.repeat(43)}`;
const ISSUED = {
  challengeId: 'c1',
  expiresAt: new Date('2026-11-23T12:10:00.000Z'),
  resendAvailableAt: new Date('2026-11-23T12:01:00.000Z'),
};
const SUBMITTED = {
  id: 'jr-1',
  status: 'pending',
  createdAt: new Date('2026-11-23T12:02:00.000Z'),
  statusToken: 'status-token',
};

interface EmailCodesMock {
  issueSignInChallenge: jest.Mock;
  issueReauthChallenge: jest.Mock;
  issueJoinRequestChallenge: jest.Mock;
  verifyChallenge: jest.Mock;
  consumeChallenge: jest.Mock;
  mintTrustedRequesterToken: jest.Mock;
}

interface JoinRequestsMock {
  assertAcceptingRequests: jest.Mock;
  assertSubmittable: jest.Mock;
  submit: jest.Mock;
  recoverStatusTokenForVerifiedEmail: jest.Mock;
  getPublicStatus: jest.Mock;
}

interface Harness {
  controller: EmailCodeController;
  emailCodes: EmailCodesMock;
  joinRequests: JoinRequestsMock;
}

function build(): Harness {
  const emailCodes: EmailCodesMock = {
    issueSignInChallenge: jest.fn(),
    issueReauthChallenge: jest.fn(),
    issueJoinRequestChallenge: jest.fn().mockResolvedValue(ISSUED),
    verifyChallenge: jest
      .fn()
      .mockResolvedValue({ email: 'sam@example.com', userId: null }),
    consumeChallenge: jest.fn().mockResolvedValue(true),
    mintTrustedRequesterToken: jest.fn().mockReturnValue(TRUSTED_TOKEN),
  };
  const joinRequests: JoinRequestsMock = {
    assertAcceptingRequests: jest.fn().mockResolvedValue(undefined),
    assertSubmittable: jest.fn().mockResolvedValue(undefined),
    submit: jest.fn().mockResolvedValue(SUBMITTED),
    recoverStatusTokenForVerifiedEmail: jest.fn(),
    getPublicStatus: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) => (key === 'app.nodeEnv' ? 'test' : undefined)),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'auth.jwtAccessTtlMs') return 15 * 60 * 1000;
      if (key === 'auth.jwtRefreshTtlMs') return 30 * 24 * 60 * 60 * 1000;
      throw new Error(`unexpected config key ${key}`);
    }),
  };
  const controller = new EmailCodeController(
    emailCodes as unknown as EmailCodeService,
    {} as AuthService,
    joinRequests as unknown as JoinRequestsService,
    config as unknown as ConfigService,
  );
  return { controller, emailCodes, joinRequests };
}

function makeReq(cookies: Record<string, string> = {}): Request {
  return { cookies, headers: {} } as unknown as Request;
}

interface ResponseMock {
  cookie: jest.Mock;
}

function makeRes(): Response {
  return { cookie: jest.fn() } as unknown as Response;
}

/** A response whose cookie calls the spec reads back. */
function makeObservedRes(): { res: Response; mock: ResponseMock } {
  const mock: ResponseMock = { cookie: jest.fn() };
  return { res: mock as unknown as Response, mock };
}

function trustedCookieCall(
  mock: ResponseMock,
): [string, string, Record<string, unknown>] | undefined {
  const calls = mock.cookie.mock.calls as [
    string,
    string,
    Record<string, unknown>,
  ][];
  return calls.find((call) => call[0] === 'email_code_trusted');
}

function form(
  overrides: Partial<VerifyJoinRequestEmailCodeDto> = {},
): VerifyJoinRequestEmailCodeDto {
  return Object.assign(new VerifyJoinRequestEmailCodeDto(), {
    name: 'Sam',
    message: 'I would love to join.',
    ageAttested: true,
    termsVersion: '1.0',
    heardFrom: 'A friend',
    challengeId: 'c1',
    code: '123456',
    ...overrides,
  });
}

describe('POST /auth/email-code/join-request/request', () => {
  it('issues a join-request code for the address and answers with the challenge only', async () => {
    const { controller, emailCodes } = build();

    const body = await controller.joinRequestCodeRequest(
      { email: 'Sam@Example.com', locale: 'pt' },
      makeReq({ email_code_requester: REQUESTER }),
      makeRes(),
    );

    expect(emailCodes.issueJoinRequestChallenge).toHaveBeenCalledWith({
      rawEmail: 'Sam@Example.com',
      requesterKey: REQUESTER,
      locale: 'pt',
    });
    expect(body).toEqual({
      challengeId: 'c1',
      expiresAt: '2026-11-23T12:10:00.000Z',
      resendAvailableAt: '2026-11-23T12:01:00.000Z',
    });
  });

  // The status oracle: the code request must never consult the applicant's
  // history, so a pending, declined or cooling-down address answers exactly
  // like one that never applied.
  it('reads no join-request history, so every address gets the same answer', async () => {
    const { controller, joinRequests } = build();

    const first = await controller.joinRequestCodeRequest(
      { email: 'declined@example.com' },
      makeReq(),
      makeRes(),
    );
    const second = await controller.joinRequestCodeRequest(
      { email: 'never-applied@example.com' },
      makeReq(),
      makeRes(),
    );

    expect(first).toEqual(second);
    expect(joinRequests.submit).not.toHaveBeenCalled();
    expect(joinRequests.assertSubmittable).not.toHaveBeenCalled();
    expect(
      joinRequests.recoverStatusTokenForVerifiedEmail,
    ).not.toHaveBeenCalled();
    expect(joinRequests.getPublicStatus).not.toHaveBeenCalled();
  });

  it('sends no code while join requests are paused', async () => {
    const { controller, emailCodes, joinRequests } = build();
    joinRequests.assertAcceptingRequests.mockRejectedValue(
      new ForbiddenException({ code: 'JOIN_REQUESTS_CLOSED' }),
    );

    await expect(
      controller.joinRequestCodeRequest(
        { email: 'sam@example.com' },
        makeReq(),
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(emailCodes.issueJoinRequestChallenge).not.toHaveBeenCalled();
  });
});

describe('POST /auth/email-code/join-request/verify', () => {
  it('files the request under the address the code was sent to, then spends the code', async () => {
    const { controller, emailCodes, joinRequests } = build();

    const result = await controller.joinRequestCodeVerify(
      form(),
      makeReq({ email_code_requester: REQUESTER }),
      makeRes(),
    );

    expect(emailCodes.verifyChallenge).toHaveBeenCalledWith({
      challengeId: 'c1',
      code: '123456',
      purpose: EmailSignInChallengePurpose.JoinRequest,
      requesterKey: REQUESTER,
    });
    const submitCalls = joinRequests.submit.mock.calls as unknown[][];
    const filed = submitCalls[0]?.[0];
    expect(filed).toEqual(
      expect.objectContaining({ email: 'sam@example.com', name: 'Sam' }),
    );
    expect(filed).not.toHaveProperty('code');
    expect(filed).not.toHaveProperty('challengeId');
    expect(result).toBe(SUBMITTED);
    expect(emailCodes.consumeChallenge).toHaveBeenCalledWith('c1');
    expect(joinRequests.submit.mock.invocationCallOrder[0]).toBeLessThan(
      emailCodes.consumeChallenge.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('still answers with the filed request when spending the code fails', async () => {
    const { controller, emailCodes } = build();
    emailCodes.consumeChallenge.mockRejectedValue(new Error('db blip'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      controller.joinRequestCodeVerify(
        form(),
        makeReq({ email_code_requester: REQUESTER }),
        makeRes(),
      ),
    ).resolves.toBe(SUBMITTED);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('jr-1'));
    warn.mockRestore();
  });

  // Squatting: a stranger who only knows an address cannot file in its name.
  it('files nothing when the code is wrong', async () => {
    const { controller, emailCodes, joinRequests } = build();
    emailCodes.verifyChallenge.mockRejectedValue(
      new EmailCodeRefusedError('code_incorrect', { attemptsLeft: 2 }),
    );

    await expect(
      controller.joinRequestCodeVerify(
        form({ code: '000000' }),
        makeReq(),
        makeRes(),
      ),
    ).rejects.toMatchObject({ reason: 'code_incorrect' });
    expect(joinRequests.submit).not.toHaveBeenCalled();
    expect(emailCodes.consumeChallenge).not.toHaveBeenCalled();
  });

  it('files nothing when the browser holds no requester cookie', async () => {
    const { controller, emailCodes, joinRequests } = build();
    emailCodes.verifyChallenge.mockRejectedValue(
      new EmailCodeRefusedError('code_incorrect', { attemptsLeft: 2 }),
    );

    await expect(
      controller.joinRequestCodeVerify(form(), makeReq(), makeRes()),
    ).rejects.toMatchObject({ reason: 'code_incorrect' });
    expect(emailCodes.verifyChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ requesterKey: '' }),
    );
    expect(joinRequests.submit).not.toHaveBeenCalled();
  });

  // The oracle: the cooldown and pending answers live in `submit`, which only
  // runs after the code checks out, so a wrong code answers the same for an
  // address that is pending, declined or new.
  it('answers a wrong code identically whatever the address has on file', async () => {
    const refusals: unknown[] = [];
    for (const onFile of ['pending', 'declined', 'none']) {
      const { controller, emailCodes, joinRequests } = build();
      emailCodes.verifyChallenge.mockRejectedValue(
        new EmailCodeRefusedError('code_incorrect', { attemptsLeft: 2 }),
      );
      joinRequests.submit.mockRejectedValue(
        onFile === 'pending'
          ? new ConflictException({ code: 'JOIN_REQUEST_PENDING' })
          : new ForbiddenException({ code: 'REAPPLICATION_COOLDOWN' }),
      );
      try {
        await controller.joinRequestCodeVerify(form(), makeReq(), makeRes());
      } catch (error) {
        refusals.push(
          error instanceof EmailCodeRefusedError ? error.getResponse() : error,
        );
      }
    }
    expect(refusals).toHaveLength(3);
    expect(refusals[1]).toEqual(refusals[0]);
    expect(refusals[2]).toEqual(refusals[0]);
  });

  it('tells the verified applicant about their own cooldown and keeps the code unspent', async () => {
    const { controller, emailCodes, joinRequests } = build();
    joinRequests.submit.mockRejectedValue(
      new ForbiddenException({ code: 'REAPPLICATION_COOLDOWN' }),
    );

    await expect(
      controller.joinRequestCodeVerify(
        form(),
        makeReq({ email_code_requester: REQUESTER }),
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(emailCodes.verifyChallenge).toHaveBeenCalledTimes(1);
    expect(emailCodes.consumeChallenge).not.toHaveBeenCalled();
  });

  it('runs the address-free checks before the code is weighed', async () => {
    const { controller, emailCodes, joinRequests } = build();
    joinRequests.assertSubmittable.mockRejectedValue(
      new ForbiddenException({ code: 'UNDER_18' }),
    );

    await expect(
      controller.joinRequestCodeVerify(
        form({ dateOfBirth: '2015-01-01' }),
        makeReq({ email_code_requester: REQUESTER }),
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(joinRequests.assertSubmittable).toHaveBeenCalledWith(
      expect.objectContaining({ dateOfBirth: '2015-01-01' }),
    );
    expect(emailCodes.verifyChallenge).not.toHaveBeenCalled();
    expect(joinRequests.submit).not.toHaveBeenCalled();
  });
});

// SEC-11: a browser that filed with a correct code becomes a trusted
// requester for that address.
describe('join-request trusted-requester cookie', () => {
  it('passes the trusted cookie the browser holds to the code request', async () => {
    const { controller, emailCodes } = build();

    await controller.joinRequestCodeRequest(
      { email: 'sam@example.com', locale: 'en' },
      makeReq({
        email_code_requester: REQUESTER,
        email_code_trusted: TRUSTED_TOKEN,
      }),
      makeRes(),
    );

    expect(emailCodes.issueJoinRequestChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ trustedRequesterToken: TRUSTED_TOKEN }),
    );
  });

  it('sets the trusted cookie for the verified address once the request is filed', async () => {
    const { controller, emailCodes } = build();
    const { res, mock } = makeObservedRes();

    await controller.joinRequestCodeVerify(
      form(),
      makeReq({ email_code_requester: REQUESTER }),
      res,
    );

    expect(emailCodes.mintTrustedRequesterToken).toHaveBeenCalledWith(
      'sam@example.com',
    );
    const call = trustedCookieCall(mock);
    expect(call?.[1]).toBe(TRUSTED_TOKEN);
    expect(call?.[1]).not.toContain('sam');
    expect(call?.[2]).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/auth/email-code',
      maxAge: 90 * 24 * 60 * 60 * 1000,
    });
  });

  it('sets no trusted cookie when the code is wrong or the filing is refused', async () => {
    const wrongCode = build();
    wrongCode.emailCodes.verifyChallenge.mockRejectedValue(
      new EmailCodeRefusedError('code_incorrect', { attemptsLeft: 2 }),
    );
    const wrongCodeRes = makeObservedRes();
    await expect(
      wrongCode.controller.joinRequestCodeVerify(
        form(),
        makeReq({ email_code_requester: REQUESTER }),
        wrongCodeRes.res,
      ),
    ).rejects.toMatchObject({ reason: 'code_incorrect' });
    expect(trustedCookieCall(wrongCodeRes.mock)).toBeUndefined();

    const refused = build();
    refused.joinRequests.submit.mockRejectedValue(
      new ForbiddenException({ code: 'REAPPLICATION_COOLDOWN' }),
    );
    const refusedRes = makeObservedRes();
    await expect(
      refused.controller.joinRequestCodeVerify(
        form(),
        makeReq({ email_code_requester: REQUESTER }),
        refusedRes.res,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(trustedCookieCall(refusedRes.mock)).toBeUndefined();
  });
});

describe('join-request code routing', () => {
  const handlers = ['joinRequestCodeRequest', 'joinRequestCodeVerify'] as const;

  it.each(handlers)('%s is public and version neutral', (handler) => {
    const method = EmailCodeController.prototype[handler];
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, method)).toBe(true);
    expect(Reflect.getMetadata(VERSION_METADATA, method)).toBe(VERSION_NEUTRAL);
  });

  // Signing in stays open during a lockdown; asking to join closes with the platform.
  it.each(handlers)('%s stays closed during a lockdown', (handler) => {
    expect(
      Reflect.getMetadata(
        LOCKDOWN_EXEMPT_KEY,
        EmailCodeController.prototype[handler],
      ),
    ).toBe(false);
  });

  it('throttles filing at 10 per hour', () => {
    const handler: keyof EmailCodeController = 'joinRequestCodeVerify';
    const method = EmailCodeController.prototype[handler];
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(
      60 * 60 * 1000,
    );
  });
});
