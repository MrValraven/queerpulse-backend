import { HttpStatus, INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { JoinRequestsService } from '../../membership/join-requests.service';
import { AuthService } from '../auth.service';
import { EmailCodeEnabledGuard } from './email-code-enabled.guard';
import { EmailCodeRefusedError } from './email-code-refusal';
import {
  EmailCodeRequestAddressThrottlerGuard,
  EmailCodeRequestIpThrottlerGuard,
  EmailCodeVerifyIpThrottlerGuard,
} from './email-code-throttler.guards';
import { EmailCodeController } from './email-code.controller';
import { EmailCodeService } from './email-code.service';

const UNAVAILABLE_BODY = {
  reason: 'email_code_unavailable',
  message: 'email_code_unavailable',
};

function configWith(isEnabled: boolean | undefined): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'email.enabled' ? isEnabled : undefined,
    ),
  } as unknown as ConfigService;
}

function refusalOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the guard to refuse');
}

describe('EmailCodeEnabledGuard', () => {
  it('lets the request through when the feature is on', () => {
    expect(new EmailCodeEnabledGuard(configWith(true)).canActivate()).toBe(
      true,
    );
  });

  it.each([false, undefined])(
    'refuses with 503 email_code_unavailable when email.enabled is %s',
    (isEnabled) => {
      const guard = new EmailCodeEnabledGuard(configWith(isEnabled));
      const refusal = refusalOf(() => guard.canActivate());

      expect(refusal).toBeInstanceOf(EmailCodeRefusedError);
      const error = refusal as EmailCodeRefusedError;
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(error.getResponse()).toEqual(UNAVAILABLE_BODY);
    },
  );

  it('is the only class-level guard on EmailCodeController, so it runs before the throttler guards', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, EmailCodeController)).toEqual([
      EmailCodeEnabledGuard,
    ]);
  });
});

describe('EmailCodeController routes with the feature switched off', () => {
  let app: INestApplication;
  const throttlerPass = { canActivate: jest.fn(() => true) };
  const emailCodes = {
    issueSignInChallenge: jest.fn(),
    issueReauthChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    consumeChallenge: jest.fn(),
  };
  const authService = {
    signInWithVerifiedEmail: jest.fn(),
    revokeSessionForToken: jest.fn(),
    issueTokens: jest.fn(),
    mintReauthToken: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EmailCodeController],
      providers: [
        { provide: EmailCodeService, useValue: emailCodes },
        { provide: AuthService, useValue: authService },
        { provide: JoinRequestsService, useValue: {} },
        { provide: ConfigService, useValue: configWith(false) },
      ],
    })
      .overrideGuard(EmailCodeRequestIpThrottlerGuard)
      .useValue(throttlerPass)
      .overrideGuard(EmailCodeRequestAddressThrottlerGuard)
      .useValue(throttlerPass)
      .overrideGuard(EmailCodeVerifyIpThrottlerGuard)
      .useValue(throttlerPass)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['/auth/email-code/request', { email: 'sam@example.com' }],
    ['/auth/email-code/verify', { challengeId: 'c1', code: '123456' }],
    ['/auth/email-code/reauth/request', { locale: 'en' }],
    ['/auth/email-code/reauth/verify', { challengeId: 'c1', code: '123456' }],
  ])(
    '%s answers 503 email_code_unavailable, sets no cookie and does no work',
    async (path, body) => {
      const response = await request(app.getHttpServer() as App)
        .post(path)
        .send(body);

      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.body).toEqual(UNAVAILABLE_BODY);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(throttlerPass.canActivate).not.toHaveBeenCalled();
      for (const mock of [
        ...Object.values(emailCodes),
        ...Object.values(authService),
      ]) {
        expect(mock).not.toHaveBeenCalled();
      }
    },
  );
});
