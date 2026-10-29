import { HttpException, HttpStatus } from '@nestjs/common';

/** Every reason the welcome email route can refuse with. */
export type WelcomeInviteReason =
  | 'join_request_not_found'
  | 'invite_not_usable'
  | 'welcome_email_not_configured'
  | 'welcome_email_rejected'
  | 'welcome_email_unavailable';

const STATUS_BY_REASON: Record<WelcomeInviteReason, HttpStatus> = {
  join_request_not_found: HttpStatus.NOT_FOUND,
  invite_not_usable: HttpStatus.CONFLICT,
  welcome_email_not_configured: HttpStatus.SERVICE_UNAVAILABLE,
  welcome_email_rejected: HttpStatus.BAD_GATEWAY,
  welcome_email_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
};

/**
 * The one error the welcome email route throws when it refuses. The body is
 * `{ reason, message: reason }`, the same shape the email-code routes use, so
 * the review screen can name exactly what went wrong.
 */
export class WelcomeInviteRefusedError extends HttpException {
  constructor(readonly reason: WelcomeInviteReason) {
    super({ reason, message: reason }, STATUS_BY_REASON[reason]);
  }
}
