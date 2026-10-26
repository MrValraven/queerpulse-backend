import { HttpException, HttpStatus } from '@nestjs/common';
import { SignupRejectedReason } from '../errors/signup-rejected.error';

/** Every reason an email code route can refuse with, besides the signup gates. */
export type EmailCodeReason =
  | 'email_invalid'
  | 'too_many_codes'
  | 'network_busy'
  | 'resend_too_soon'
  | 'email_send_failed'
  | 'email_code_unavailable'
  | 'code_incorrect'
  | 'code_expired'
  | 'code_used_up'
  | 'code_replaced'
  | 'code_already_used'
  | 'too_many_attempts'
  | 'account_recovery_review'
  | 'name_required';

/** The details a refusal can carry so the screen can say what happens next. */
export interface EmailCodeRefusalExtras {
  attemptsLeft?: number;
  retryAt?: Date;
  resendAvailableAt?: Date;
  statusUrl?: string;
}

const SERVICE_UNAVAILABLE_REASONS: ReadonlySet<string> =
  new Set<EmailCodeReason>(['email_send_failed', 'email_code_unavailable']);

const BAD_REQUEST_REASONS: ReadonlySet<string> = new Set<EmailCodeReason>([
  'email_invalid',
  'code_incorrect',
  'code_expired',
  'code_used_up',
  'code_replaced',
  'code_already_used',
]);

const TOO_MANY_REQUESTS_REASONS: ReadonlySet<string> = new Set<EmailCodeReason>(
  ['too_many_codes', 'network_busy', 'resend_too_soon', 'too_many_attempts'],
);

/**
 * The HTTP status for a refusal. A bad code is a 400, so the frontend keeps
 * the session it holds (it reads a 401 as a dead session); limits are 429; a
 * failed send and the feature being switched off (`email_code_unavailable`)
 * are 503; `account_recovery_review`, `name_required` and every signup gate
 * are 403.
 */
export function emailCodeRefusalStatus(
  reason: EmailCodeReason | SignupRejectedReason,
): number {
  if (BAD_REQUEST_REASONS.has(reason)) return HttpStatus.BAD_REQUEST;
  if (TOO_MANY_REQUESTS_REASONS.has(reason)) {
    return HttpStatus.TOO_MANY_REQUESTS;
  }
  if (SERVICE_UNAVAILABLE_REASONS.has(reason)) {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }
  return HttpStatus.FORBIDDEN;
}

/** `{ reason, message: reason, ...extras }`, dates as ISO 8601, undefined
 *  extras left out. */
function refusalBody(
  reason: EmailCodeReason | SignupRejectedReason,
  extras: EmailCodeRefusalExtras = {},
): Record<string, string | number> {
  const body: Record<string, string | number> = { reason, message: reason };
  if (extras.attemptsLeft !== undefined) {
    body.attemptsLeft = extras.attemptsLeft;
  }
  if (extras.retryAt !== undefined) body.retryAt = extras.retryAt.toISOString();
  if (extras.resendAvailableAt !== undefined) {
    body.resendAvailableAt = extras.resendAvailableAt.toISOString();
  }
  if (extras.statusUrl !== undefined) body.statusUrl = extras.statusUrl;
  return body;
}

/**
 * The one error every email code route throws when it refuses. The body names
 * the specific reason so the screen can say exactly what went wrong.
 */
export class EmailCodeRefusedError extends HttpException {
  constructor(
    readonly reason: EmailCodeReason | SignupRejectedReason,
    extras?: EmailCodeRefusalExtras,
  ) {
    super(refusalBody(reason, extras), emailCodeRefusalStatus(reason));
  }
}
