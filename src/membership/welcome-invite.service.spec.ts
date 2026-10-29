import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Invite, InviteStatus } from './entities/invite.entity';
import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from './entities/join-request.entity';
import { WelcomeInviteRefusedError } from './welcome-invite-refusal';
import {
  buildInviteLink,
  escapeHtml,
  formatExpiresOn,
} from './welcome-invite-variables';
import { WelcomeInviteMailer } from './welcome-invite.mailer';
import { WelcomeInviteService } from './welcome-invite.service';

const FUTURE_EXPIRY = new Date('2099-11-05T10:00:00Z');

function buildRequest(
  overrides: Partial<PlatformJoinRequest> = {},
): PlatformJoinRequest {
  return {
    id: 'request-1',
    email: 'sam@example.com',
    name: 'Sam <b>"Rivera"</b> & Co',
    status: PlatformJoinRequestStatus.Approved,
    inviteId: 'invite-1',
    ...overrides,
  } as PlatformJoinRequest;
}

function buildInvite(overrides: Partial<Invite> = {}): Invite {
  return {
    id: 'invite-1',
    code: 'QP-ABCD',
    status: InviteStatus.Pending,
    expiresAt: FUTURE_EXPIRY,
    ...overrides,
  } as Invite;
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WelcomeInviteRefusedError) return error.reason;
    throw error;
  }
  throw new Error('Expected a WelcomeInviteRefusedError');
}

describe('WelcomeInviteService', () => {
  let joinRequests: { findOne: jest.Mock };
  let invites: { findOne: jest.Mock };
  let mailer: { isConfiguredFor: jest.Mock; sendWelcomeInvite: jest.Mock };
  let service: WelcomeInviteService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    joinRequests = { findOne: jest.fn().mockResolvedValue(buildRequest()) };
    invites = { findOne: jest.fn().mockResolvedValue(buildInvite()) };
    mailer = {
      isConfiguredFor: jest.fn().mockReturnValue(true),
      sendWelcomeInvite: jest
        .fn()
        .mockResolvedValue({ delivered: true, emailId: 'email-1' }),
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'app.frontendUrl' ? 'https://queerpulse.com' : undefined,
      ),
    } as unknown as ConfigService;
    service = new WelcomeInviteService(
      joinRequests as unknown as Repository<PlatformJoinRequest>,
      invites as unknown as Repository<Invite>,
      mailer as unknown as WelcomeInviteMailer,
      config,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends to the address on the join request with escaped name, full link and a Lisbon-day date', async () => {
    const result = await service.sendWelcomeEmail(
      'request-1',
      'reviewer-1',
      'en',
    );

    expect(result).toEqual({ sent: true });
    expect(mailer.sendWelcomeInvite).toHaveBeenCalledTimes(1);
    const sent = (
      mailer.sendWelcomeInvite.mock.calls as unknown[][]
    )[0]?.[0] as {
      to: string;
      variables: Record<string, string>;
      idempotencyKey: string;
    };
    expect(sent.to).toBe('sam@example.com');
    expect(sent.variables.name).toBe(
      'Sam &lt;b&gt;&quot;Rivera&quot;&lt;/b&gt; &amp; Co',
    );
    expect(sent.variables.inviteLink).toBe(
      'https://queerpulse.com/auth/invite/QP-ABCD',
    );
    expect(sent.variables.expiresOn).toBe('5 November 2099');
    expect(sent.idempotencyKey).toBe(
      `welcome-invite/invite-1/en/${FUTURE_EXPIRY.getTime() / 1000}`,
    );
  });

  it('formats the date in Portuguese', async () => {
    await service.sendWelcomeEmail('request-1', 'reviewer-1', 'pt');

    const sent = (
      mailer.sendWelcomeInvite.mock.calls as unknown[][]
    )[0]?.[0] as {
      variables: Record<string, string>;
    };
    expect(sent.variables.expiresOn).toBe('5 de novembro de 2099');
  });

  it('refuses with join_request_not_found when no request has the id', async () => {
    joinRequests.findOne.mockResolvedValue(null);

    expect(
      await reasonOf(service.sendWelcomeEmail('missing', 'reviewer-1', 'en')),
    ).toBe('join_request_not_found');
    expect(mailer.sendWelcomeInvite).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a request that is not approved',
      { status: PlatformJoinRequestStatus.Pending },
      buildInvite(),
    ],
    ['a request without an invite', { inviteId: null }, buildInvite()],
    ['a missing invite row', {}, null],
    ['a revoked invite', {}, buildInvite({ status: InviteStatus.Revoked })],
    ['an accepted invite', {}, buildInvite({ status: InviteStatus.Accepted })],
    [
      'a swept expired invite',
      {},
      buildInvite({ status: InviteStatus.Expired }),
    ],
    [
      'a pending invite past its expiry',
      {},
      buildInvite({ expiresAt: new Date('2020-01-01T00:00:00Z') }),
    ],
    ['an invite with no expiry date', {}, buildInvite({ expiresAt: null })],
  ])(
    'refuses with invite_not_usable for %s',
    async (_label, requestOverrides, invite) => {
      joinRequests.findOne.mockResolvedValue(buildRequest(requestOverrides));
      invites.findOne.mockResolvedValue(invite);

      expect(
        await reasonOf(
          service.sendWelcomeEmail('request-1', 'reviewer-1', 'en'),
        ),
      ).toBe('invite_not_usable');
      expect(mailer.sendWelcomeInvite).not.toHaveBeenCalled();
    },
  );

  it('refuses with welcome_email_not_configured before sending when the language has no template', async () => {
    mailer.isConfiguredFor.mockReturnValue(false);

    expect(
      await reasonOf(service.sendWelcomeEmail('request-1', 'reviewer-1', 'pt')),
    ).toBe('welcome_email_not_configured');
    expect(mailer.isConfiguredFor).toHaveBeenCalledWith('pt');
    expect(mailer.sendWelcomeInvite).not.toHaveBeenCalled();
  });

  it.each([
    ['resend_rejected', 'welcome_email_rejected'],
    ['resend_unavailable', 'welcome_email_unavailable'],
    ['not_configured', 'welcome_email_not_configured'],
  ])('maps the mailer failure %s to %s', async (failure, reason) => {
    mailer.sendWelcomeInvite.mockResolvedValue({ delivered: false, failure });

    expect(
      await reasonOf(service.sendWelcomeEmail('request-1', 'reviewer-1', 'en')),
    ).toBe(reason);
  });

  it('answers each reason with its own HTTP status', () => {
    expect(
      new WelcomeInviteRefusedError('join_request_not_found').getStatus(),
    ).toBe(404);
    expect(new WelcomeInviteRefusedError('invite_not_usable').getStatus()).toBe(
      409,
    );
    expect(
      new WelcomeInviteRefusedError('welcome_email_not_configured').getStatus(),
    ).toBe(503);
    expect(
      new WelcomeInviteRefusedError('welcome_email_rejected').getStatus(),
    ).toBe(502);
    expect(
      new WelcomeInviteRefusedError('welcome_email_unavailable').getStatus(),
    ).toBe(503);
    expect(
      new WelcomeInviteRefusedError('invite_not_usable').getResponse(),
    ).toEqual({
      reason: 'invite_not_usable',
      message: 'invite_not_usable',
    });
  });
});

describe('welcome invite variables', () => {
  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('builds the link from the origin without doubling the slash', () => {
    expect(buildInviteLink('https://queerpulse.com/', 'QP-1')).toBe(
      'https://queerpulse.com/auth/invite/QP-1',
    );
  });

  it('formats the date on the Lisbon day', () => {
    // 23:30 UTC on 30 Jun is already 1 Jul in Lisbon (summer time, UTC+1).
    expect(formatExpiresOn(new Date('2026-06-30T23:30:00Z'), 'en')).toBe(
      '1 July 2026',
    );
    expect(formatExpiresOn(new Date('2026-11-05T12:00:00Z'), 'pt')).toBe(
      '5 de novembro de 2026',
    );
  });
});
