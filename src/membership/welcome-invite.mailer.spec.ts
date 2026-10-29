import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import {
  WelcomeInviteEmail,
  WelcomeInviteMailer,
} from './welcome-invite.mailer';

jest.mock('resend', () => ({ Resend: jest.fn() }));

const ResendMock = Resend as unknown as jest.Mock;

const RESEND_REFUSAL_MESSAGE = 'Recipient domain blocked by sender policy';
const APPLICANT_ADDRESS = 'sam@example.com';
const APPLICANT_NAME = 'Sam Rivera';
const INVITE_LINK = 'https://queerpulse.com/auth/invite/QP-SECRET-CODE';

const EMAIL: WelcomeInviteEmail = {
  to: APPLICANT_ADDRESS,
  locale: 'pt',
  variables: {
    name: APPLICANT_NAME,
    inviteLink: INVITE_LINK,
    expiresOn: '5 de novembro de 2026',
  },
  joinRequestId: 'request-1',
  idempotencyKey: 'welcome-invite/invite-1/pt/1793000000',
};

const CONFIGURED: Record<string, string | undefined> = {
  'email.resendApiKey': 're_test_key',
  'email.from': 'QueerPulse <hello@queerpulse.com>',
  'email.welcomeTemplateIdEn': 'welcome-en',
  'email.welcomeTemplateIdPt': 'welcome-pt',
};

function buildConfig(values: Record<string, string | undefined>) {
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

describe('WelcomeInviteMailer', () => {
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

  it('reports each language as configured only with the key and its own template id', () => {
    const withoutPortuguese = new WelcomeInviteMailer(
      buildConfig({ ...CONFIGURED, 'email.welcomeTemplateIdPt': undefined }),
    );
    expect(withoutPortuguese.isConfiguredFor('en')).toBe(true);
    expect(withoutPortuguese.isConfiguredFor('pt')).toBe(false);

    const withoutKey = new WelcomeInviteMailer(
      buildConfig({ ...CONFIGURED, 'email.resendApiKey': undefined }),
    );
    expect(withoutKey.isConfiguredFor('en')).toBe(false);
    expect(withoutKey.isConfiguredFor('pt')).toBe(false);
  });

  it('answers not_configured and calls Resend never when the key is unset', async () => {
    const mailer = new WelcomeInviteMailer(
      buildConfig({ ...CONFIGURED, 'email.resendApiKey': undefined }),
    );

    const result = await mailer.sendWelcomeInvite(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'not_configured' });
    expect(ResendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('RESEND_API_KEY'),
    );
  });

  it('names the Portuguese template variable when only that id is unset', async () => {
    const mailer = new WelcomeInviteMailer(
      buildConfig({ ...CONFIGURED, 'email.welcomeTemplateIdPt': undefined }),
    );

    const result = await mailer.sendWelcomeInvite(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'not_configured' });
    expect(send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('RESEND_WELCOME_TEMPLATE_ID_PT'),
    );
  });

  it('sends the Portuguese template with the three variables and the idempotency key', async () => {
    send.mockResolvedValue(success('email-1'));
    const mailer = new WelcomeInviteMailer(buildConfig(CONFIGURED));

    const result = await mailer.sendWelcomeInvite(EMAIL);

    expect(result).toEqual({ delivered: true, emailId: 'email-1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      {
        from: 'QueerPulse <hello@queerpulse.com>',
        to: APPLICANT_ADDRESS,
        template: {
          id: 'welcome-pt',
          variables: {
            name: APPLICANT_NAME,
            inviteLink: INVITE_LINK,
            expiresOn: '5 de novembro de 2026',
          },
        },
      },
      expect.objectContaining({
        idempotencyKey: 'welcome-invite/invite-1/pt/1793000000',
      }),
    );
  });

  it('sends the English template for the en locale', async () => {
    send.mockResolvedValue(success('email-2'));
    const mailer = new WelcomeInviteMailer(buildConfig(CONFIGURED));

    await mailer.sendWelcomeInvite({ ...EMAIL, locale: 'en' });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: { id: 'welcome-en', variables: EMAIL.variables },
      }),
      expect.anything(),
    );
  });

  it('does not retry a refusal and reports resend_rejected', async () => {
    send.mockResolvedValue(failure(422, 'validation_error'));
    const mailer = new WelcomeInviteMailer(buildConfig(CONFIGURED));

    const result = await mailer.sendWelcomeInvite(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'resend_rejected' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 and delivers on the second attempt', async () => {
    send
      .mockResolvedValueOnce(failure(500, 'application_error'))
      .mockResolvedValueOnce(success('email-3'));
    const mailer = new WelcomeInviteMailer(buildConfig(CONFIGURED));

    const pending = mailer.sendWelcomeInvite(EMAIL);
    await jest.advanceTimersByTimeAsync(300);
    const result = await pending;

    expect(result).toEqual({ delivered: true, emailId: 'email-3' });
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls as unknown[][])[1]?.[1]).toEqual(
      expect.objectContaining({ idempotencyKey: EMAIL.idempotencyKey }),
    );
  });

  it('gives up after three attempts and reports resend_unavailable', async () => {
    send.mockResolvedValue(failure(503, 'application_error'));
    const mailer = new WelcomeInviteMailer(buildConfig(CONFIGURED));

    const pending = mailer.sendWelcomeInvite(EMAIL);
    await jest.advanceTimersByTimeAsync(300 + 900);
    const result = await pending;

    expect(result).toEqual({ delivered: false, failure: 'resend_unavailable' });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('treats a thrown timeout as a network error and retries it', async () => {
    send
      .mockRejectedValueOnce(new Error('The operation was aborted'))
      .mockResolvedValueOnce(success('email-4'));
    const mailer = new WelcomeInviteMailer(buildConfig(CONFIGURED));

    const pending = mailer.sendWelcomeInvite(EMAIL);
    await jest.advanceTimersByTimeAsync(300);
    const result = await pending;

    expect(result).toEqual({ delivered: true, emailId: 'email-4' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ends the send when Resend asks for a wait longer than the cap', async () => {
    send.mockResolvedValue(
      failure(429, 'rate_limit_exceeded', { 'retry-after': '30' }),
    );
    const mailer = new WelcomeInviteMailer(buildConfig(CONFIGURED));

    const result = await mailer.sendWelcomeInvite(EMAIL);

    expect(result).toEqual({ delivered: false, failure: 'resend_unavailable' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the address, name, invite link and Resend message out of every log line', async () => {
    send
      .mockResolvedValueOnce(failure(500, 'application_error'))
      .mockResolvedValueOnce(failure(422, 'validation_error'));
    const mailer = new WelcomeInviteMailer(buildConfig(CONFIGURED));

    const pending = mailer.sendWelcomeInvite(EMAIL);
    await jest.advanceTimersByTimeAsync(300);
    await pending;
    send.mockResolvedValue(success('email-5'));
    await mailer.sendWelcomeInvite(EMAIL);

    const logged = allLoggedText();
    expect(logged).toContain('request-1');
    expect(logged).not.toContain(APPLICANT_ADDRESS);
    expect(logged).not.toContain(APPLICANT_NAME);
    expect(logged).not.toContain('QP-SECRET-CODE');
    expect(logged).not.toContain(RESEND_REFUSAL_MESSAGE);
  });
});
