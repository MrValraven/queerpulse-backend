import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EmailCodeMailer, SignInCodeEmail } from './email-code.mailer';

jest.mock('resend', () => ({ Resend: jest.fn() }));

const ResendMock = Resend as unknown as jest.Mock;

const RESEND_REFUSAL_MESSAGE = 'Recipient domain blocked by sender policy';

const EMAIL: SignInCodeEmail = {
  to: 'sam@example.com',
  code: '123456',
  minutes: 10,
  locale: 'pt',
  challengeId: 'c1',
};

const CONFIGURED: Record<string, string | undefined> = {
  'app.nodeEnv': 'production',
  'email.resendApiKey': 're_test_key',
  'email.from': 'QueerPulse <hello@queerpulse.com>',
  'email.signInTemplateIdEn': 'tpl-en',
  'email.signInTemplateIdPt': 'tpl-pt',
};

function buildConfig(
  values: Record<string, string | boolean | undefined>,
): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function success(emailId: string) {
  return { data: { id: emailId }, error: null, headers: {} };
}

function failure(
  statusCode: number | null,
  name: string,
  headers: Record<string, string> | null = null,
) {
  return {
    data: null,
    error: { statusCode, name, message: RESEND_REFUSAL_MESSAGE },
    headers,
  };
}

describe('EmailCodeMailer', () => {
  let send: jest.Mock;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  function allLoggedText(): string {
    return [logSpy, warnSpy, errorSpy]
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .map((callArguments) => callArguments.map(String).join(' '))
      .join('\n');
  }

  beforeEach(() => {
    jest.useFakeTimers();
    send = jest.fn();
    ResendMock.mockReset();
    ResendMock.mockImplementation(() => ({ emails: { send } }));
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('logs the code with a [dev] prefix and sends nothing when no key is set and the dev log is on outside production', async () => {
    const mailer = new EmailCodeMailer(
      buildConfig({ 'app.nodeEnv': 'development', 'email.devLog': true }),
    );

    const result = await mailer.sendSignInCode(EMAIL);

    expect(result).toEqual({ delivered: true, emailId: null });
    expect(logSpy).toHaveBeenCalledWith(
      '[dev] sign-in code for challenge c1: 123456',
    );
    expect(ResendMock).not.toHaveBeenCalled();
  });

  it('refuses to send and logs no code outside production when the dev log is off', async () => {
    const mailer = new EmailCodeMailer(
      buildConfig({ 'app.nodeEnv': 'development', 'email.devLog': false }),
    );

    const result = await mailer.sendSignInCode(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'not_configured' });
    expect(ResendMock).not.toHaveBeenCalled();
    expect(allLoggedText()).not.toContain('123456');
  });

  it('never logs the code in production, even with the dev log flag set', async () => {
    const mailer = new EmailCodeMailer(
      buildConfig({ 'app.nodeEnv': 'production', 'email.devLog': true }),
    );

    const result = await mailer.sendSignInCode(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'not_configured' });
    expect(ResendMock).not.toHaveBeenCalled();
    expect(allLoggedText()).not.toContain('123456');
  });

  it('refuses to send and logs no code in production without a key', async () => {
    const mailer = new EmailCodeMailer(
      buildConfig({ 'app.nodeEnv': 'production' }),
    );

    const result = await mailer.sendSignInCode(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'not_configured' });
    expect(ResendMock).not.toHaveBeenCalled();
    expect(allLoggedText()).not.toContain('123456');
  });

  it('answers not_configured when the template id for the locale is missing', async () => {
    const mailer = new EmailCodeMailer(
      buildConfig({ ...CONFIGURED, 'email.signInTemplateIdPt': undefined }),
    );

    const result = await mailer.sendSignInCode(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'not_configured' });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the locale's template with the code and minutes under a per-challenge idempotency key", async () => {
    send.mockResolvedValueOnce(success('re_1'));
    const mailer = new EmailCodeMailer(buildConfig(CONFIGURED));

    const result = await mailer.sendSignInCode(EMAIL);

    expect(ResendMock).toHaveBeenCalledTimes(1);
    expect(ResendMock).toHaveBeenCalledWith('re_test_key');
    expect(send).toHaveBeenCalledWith(
      {
        from: 'QueerPulse <hello@queerpulse.com>',
        to: 'sam@example.com',
        template: {
          id: 'tpl-pt',
          variables: { code: '123456', minutes: 10 },
        },
      },
      {
        idempotencyKey: 'sign-in-code/c1',
        signal: expect.any(AbortSignal) as AbortSignal,
      },
    );
    expect(result).toEqual({ delivered: true, emailId: 're_1' });
    expect(logSpy).toHaveBeenCalledWith(
      'Sign-in code email accepted by Resend: emailId=re_1 challengeId=c1',
    );
  });

  it.each([
    ['a network error', null, 'application_error'],
    ['a 500', 500, 'internal_server_error'],
    ['a 429', 429, 'rate_limit_exceeded'],
  ])(
    'retries network errors, 5xx and 429 up to three tries in all (%s)',
    async (_label, statusCode, name) => {
      send.mockResolvedValue(failure(statusCode, name));
      const mailer = new EmailCodeMailer(buildConfig(CONFIGURED));

      const pending = mailer.sendSignInCode(EMAIL);
      await jest.advanceTimersByTimeAsync(300 + 900);
      const result = await pending;

      expect(result).toEqual({
        delivered: false,
        failure: 'resend_unavailable',
      });
      expect(send).toHaveBeenCalledTimes(3);
    },
  );

  it('waits the retry-after seconds Resend asks for', async () => {
    send
      .mockResolvedValueOnce(
        failure(429, 'rate_limit_exceeded', { 'retry-after': '1' }),
      )
      .mockResolvedValueOnce(success('re_2'));
    const mailer = new EmailCodeMailer(buildConfig(CONFIGURED));

    const pending = mailer.sendSignInCode(EMAIL);
    await jest.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ delivered: true, emailId: 're_2' });
  });

  it('gives up when retry-after is longer than 1.5 seconds', async () => {
    send.mockResolvedValue(
      failure(429, 'rate_limit_exceeded', { 'retry-after': '2' }),
    );
    const mailer = new EmailCodeMailer(buildConfig(CONFIGURED));

    const result = await mailer.sendSignInCode(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'resend_unavailable' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats an attempt that times out as a network error and retries', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    send.mockRejectedValue({ name: 'TimeoutError' });
    const mailer = new EmailCodeMailer(buildConfig(CONFIGURED));

    const pending = mailer.sendSignInCode(EMAIL);
    await jest.advanceTimersByTimeAsync(300 + 900);
    const result = await pending;

    expect(result).toEqual({ delivered: false, failure: 'resend_unavailable' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(timeoutSpy).toHaveBeenCalledWith(4000);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it('does not retry a 4xx refusal', async () => {
    send.mockResolvedValue(failure(422, 'validation_error'));
    const mailer = new EmailCodeMailer(buildConfig(CONFIGURED));

    const result = await mailer.sendSignInCode(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'resend_rejected' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never logs the address, the code or Resend's message on failure", async () => {
    send.mockResolvedValue(failure(422, 'validation_error'));
    const mailer = new EmailCodeMailer(buildConfig(CONFIGURED));

    await mailer.sendSignInCode(EMAIL);

    const logged = allLoggedText();
    expect(logged).not.toContain('sam@example.com');
    expect(logged).not.toContain('123456');
    expect(logged).not.toContain(RESEND_REFUSAL_MESSAGE);
    expect(logged).toContain('name=validation_error status=422 challengeId=c1');
  });
});
