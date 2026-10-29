import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_FRONTEND_ORIGIN } from '../config/frontend-origins';
import type { WelcomeInviteLocale } from './dto/send-welcome-invite-email.dto';
import { Invite } from './entities/invite.entity';
import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from './entities/join-request.entity';
import { resolveInviteStatus } from './invite-response';
import { WelcomeInviteRefusedError } from './welcome-invite-refusal';
import {
  buildInviteLink,
  escapeHtml,
  formatExpiresOn,
} from './welcome-invite-variables';
import { WelcomeInviteMailer } from './welcome-invite.mailer';

/**
 * Sends the welcome email for an approved join request, only when a reviewer
 * clicks "Send welcome email": `POST /admin/join-requests/:id/invite/email`.
 *
 * The recipient is the address on the join request, never one from the body.
 * Approval never triggers this on its own.
 */
@Injectable()
export class WelcomeInviteService {
  private readonly logger = new Logger(WelcomeInviteService.name);

  constructor(
    @InjectRepository(PlatformJoinRequest)
    private readonly joinRequests: Repository<PlatformJoinRequest>,
    @InjectRepository(Invite)
    private readonly invites: Repository<Invite>,
    private readonly mailer: WelcomeInviteMailer,
    private readonly config: ConfigService,
  ) {}

  /**
   * Answers with a `WelcomeInviteRefusedError` carrying one reason code:
   *  - `join_request_not_found` (404): no request has this id;
   *  - `invite_not_usable` (409): the request has no invite, or it is revoked,
   *    accepted or expired (the same resolved status reissue and revoke read);
   *  - `welcome_email_not_configured` (503): no API key, or no template id for
   *    this language;
   *  - `welcome_email_rejected` (502): Resend refused the email;
   *  - `welcome_email_unavailable` (503): Resend was down or timed out through
   *    every retry.
   */
  async sendWelcomeEmail(
    joinRequestId: string,
    reviewerId: string,
    locale: WelcomeInviteLocale,
  ): Promise<{ sent: true }> {
    const request = await this.joinRequests.findOne({
      where: { id: joinRequestId },
    });
    if (!request) {
      throw new WelcomeInviteRefusedError('join_request_not_found');
    }
    if (
      request.status !== PlatformJoinRequestStatus.Approved ||
      !request.inviteId
    ) {
      throw new WelcomeInviteRefusedError('invite_not_usable');
    }
    const invite = await this.invites.findOne({
      where: { id: request.inviteId },
    });
    if (
      !invite ||
      !invite.expiresAt ||
      resolveInviteStatus(invite, new Date()) !== 'valid'
    ) {
      throw new WelcomeInviteRefusedError('invite_not_usable');
    }
    if (!this.mailer.isConfiguredFor(locale)) {
      this.logger.error(
        `Welcome email not sent: the ${locale} template or the API key is not configured. joinRequestId=${joinRequestId}`,
      );
      throw new WelcomeInviteRefusedError('welcome_email_not_configured');
    }

    const frontendOrigin =
      this.config.get<string>('app.frontendUrl') ?? DEFAULT_FRONTEND_ORIGIN;
    const result = await this.mailer.sendWelcomeInvite({
      to: request.email,
      locale,
      variables: {
        name: escapeHtml(request.name),
        inviteLink: buildInviteLink(frontendOrigin, invite.code),
        expiresOn: formatExpiresOn(invite.expiresAt, locale),
      },
      joinRequestId,
      // One email per invite, language and expiry. A reissue moves the expiry,
      // which changes the payload, so it gets a fresh key; a double click keeps
      // the same key and Resend returns the first send instead of a second.
      idempotencyKey: `welcome-invite/${invite.id}/${locale}/${Math.floor(invite.expiresAt.getTime() / 1000)}`,
    });

    if (!result.delivered) {
      if (result.failure === 'not_configured') {
        throw new WelcomeInviteRefusedError('welcome_email_not_configured');
      }
      throw new WelcomeInviteRefusedError(
        result.failure === 'resend_rejected'
          ? 'welcome_email_rejected'
          : 'welcome_email_unavailable',
      );
    }

    this.logger.log(
      `Reviewer ${reviewerId} sent the ${locale} welcome email on join request ${joinRequestId}`,
    );
    return { sent: true };
  }
}
