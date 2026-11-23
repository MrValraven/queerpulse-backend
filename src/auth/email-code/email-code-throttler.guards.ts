import { ExecutionContext, Injectable } from '@nestjs/common';
import { hours, minutes } from '@nestjs/throttler';
import type { ThrottlerLimitDetail, ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { HttpThrottlerGuard } from '../../security/http-throttler.guard';
import { normalizeEmailAddress } from './email-code-address';
import { EmailCodeRefusedError } from './email-code-refusal';
import { deriveEmailCodeTrustedRequesterKey } from './email-code-secret';
import {
  EMAIL_CODE_TRUSTED_REQUESTER_COOKIE,
  isTrustedRequesterToken,
} from './email-code-trusted-requester';

/**
 * Per-IP and per-IP+address limits for the email code routes.
 *
 * Contract limits: asking for a code is 5 per hour for one IP and one address,
 * and 60 per hour for one IP across all addresses. A join-request code is also
 * 3 per 24 hours for one IP and one address. Checking a code is 60 per
 * 10 minutes for one IP. These counts live in memory, so each replica keeps its
 * own and they act as a cheap backstop against floods. The caps that must hold
 * across replicas (per address and purpose per 24 hours: 30 shared sign-in
 * codes plus a 10-code trusted reserve, 10 shared join-request codes plus a
 * 5-code reserve; the 60 second cooldown; the 3 wrong tries per code) are
 * enforced from the database in `EmailCodeService`.
 *
 * SEC-11: the two IP+address guards give a request carrying a valid
 * trusted-requester cookie for the typed address its own bucket (tracker
 * prefix `...-trusted:`), so a stranger on the member's public IP (venue
 * Wi-Fi, CGNAT, a shared household) cannot spend it first. The cookie's HMAC
 * is checked for the typed address before it picks the bucket, and the
 * tracker holds only the IP+address digest: the raw cookie value never keys
 * a bucket. A forged, expired or other-address cookie lands in the ordinary
 * bucket.
 *
 * Every guard carries its own limit and window in `handleRequest`, so the
 * routes need no `@Throttle` metadata and the global IP bucket keeps its
 * app-wide default. The tracker prefixes keep these buckets apart from the
 * global one, and `generateKey` already separates routes by class and handler.
 *
 * The address trackers hold a SHA-256 of the IP and the normalized address.
 * The address itself never reaches the throttler storage, a log line or a key.
 */
const ONE_HOUR_MS = hours(1);
const TEN_MINUTES_MS = minutes(10);
const ONE_DAY_MS = hours(24);

function clientIp(req: Record<string, unknown>): string {
  // Fails closed into one shared bucket; this should not occur behind `trust proxy`.
  return typeof req.ip === 'string' ? req.ip : 'unknown';
}

/** SHA-256 of the client IP and the normalized address in the body. */
function ipAndAddressFingerprint(req: Record<string, unknown>): string {
  const body = req.body as { email?: unknown } | undefined;
  const normalizedAddress =
    typeof body?.email === 'string' ? normalizeEmailAddress(body.email) : '';
  return createHash('sha256')
    .update(`${clientIp(req)}|${normalizedAddress}`)
    .digest('hex');
}

/** The address-bucket tracker: the ordinary one, or the trusted one when the
 *  request proves it verified a code for the typed address. */
function addressTracker(
  prefix: string,
  req: Record<string, unknown>,
  trustedRequesterKey: Buffer | null,
): string {
  const body = req.body as { email?: unknown } | undefined;
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const isTrusted =
    trustedRequesterKey !== null &&
    typeof body?.email === 'string' &&
    isTrustedRequesterToken(
      trustedRequesterKey,
      cookies?.[EMAIL_CODE_TRUSTED_REQUESTER_COOKIE],
      normalizeEmailAddress(body.email),
      new Date(),
    );
  return `${prefix}${isTrusted ? '-trusted' : ''}:${ipAndAddressFingerprint(req)}`;
}

/**
 * The base for the two IP+address guards. The trusted-requester key derives
 * from the config the base guard receives by property injection; without it
 * (a guard built by hand) every request uses the ordinary bucket.
 */
abstract class EmailCodeAddressThrottlerGuard extends HttpThrottlerGuard {
  private trustedRequesterKey: Buffer | null | undefined;

  protected trustedRequesterKeyOrNull(): Buffer | null {
    if (this.trustedRequesterKey !== undefined) return this.trustedRequesterKey;
    const config = this.throttlerConfig;
    this.trustedRequesterKey = config
      ? deriveEmailCodeTrustedRequesterKey(
          config.get<string>('email.codeSecret'),
          config.get<string>('auth.jwtAccessSecret'),
          config.get<string>('app.nodeEnv'),
        )
      : null;
    return this.trustedRequesterKey;
  }
}

function refuseWith(
  reason: 'too_many_codes' | 'network_busy',
  detail: ThrottlerLimitDetail,
): EmailCodeRefusedError {
  return new EmailCodeRefusedError(reason, {
    retryAt: new Date(Date.now() + detail.timeToBlockExpire * 1000),
  });
}

/** Asking for a code: 60 per hour for one IP. */
@Injectable()
export class EmailCodeRequestIpThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(`email-code-ip:${clientIp(req)}`);
  }

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: 60,
      ttl: ONE_HOUR_MS,
      blockDuration: ONE_HOUR_MS,
    });
  }

  protected throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    return Promise.reject(refuseWith('network_busy', detail));
  }
}

/** Asking for a code: 5 per hour for one IP and one address, per bucket. */
@Injectable()
export class EmailCodeRequestAddressThrottlerGuard extends EmailCodeAddressThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(
      addressTracker(
        'email-code-address',
        req,
        this.trustedRequesterKeyOrNull(),
      ),
    );
  }

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: 5,
      ttl: ONE_HOUR_MS,
      blockDuration: ONE_HOUR_MS,
    });
  }

  protected throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    return Promise.reject(refuseWith('too_many_codes', detail));
  }
}

/**
 * Asking for a join-request code: 3 per 24 hours for one IP and one address.
 *
 * The database caps join-request codes at 10 per address per day across every
 * requester. Under the hourly limit alone, one IP could spend that whole cap
 * in two hours and keep the real applicant from getting a code for the day.
 * With this daily bucket, spending the cap takes at least four IPs. An
 * applicant needs one or two codes, so 3 leaves room for one resend. A
 * trusted requester has its own 3 (SEC-11).
 */
@Injectable()
export class EmailCodeJoinRequestDailyAddressThrottlerGuard extends EmailCodeAddressThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(
      addressTracker(
        'email-code-join-request-day',
        req,
        this.trustedRequesterKeyOrNull(),
      ),
    );
  }

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: 3,
      ttl: ONE_DAY_MS,
      blockDuration: ONE_DAY_MS,
    });
  }

  protected throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    return Promise.reject(refuseWith('too_many_codes', detail));
  }
}

/** Checking a code: 60 per 10 minutes for one IP. */
@Injectable()
export class EmailCodeVerifyIpThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(`email-code-ip:${clientIp(req)}`);
  }

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: 60,
      ttl: TEN_MINUTES_MS,
      blockDuration: TEN_MINUTES_MS,
    });
  }

  protected throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    return Promise.reject(refuseWith('network_busy', detail));
  }
}
