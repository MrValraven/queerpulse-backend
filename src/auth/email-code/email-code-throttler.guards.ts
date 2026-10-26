import { ExecutionContext, Injectable } from '@nestjs/common';
import { hours, minutes } from '@nestjs/throttler';
import type { ThrottlerLimitDetail, ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { HttpThrottlerGuard } from '../../security/http-throttler.guard';
import { normalizeEmailAddress } from './email-code-address';
import { EmailCodeRefusedError } from './email-code-refusal';

/**
 * Per-IP and per-IP+address limits for the email code routes.
 *
 * Contract limits: asking for a code is 5 per hour for one IP and one address,
 * and 60 per hour for one IP across all addresses. Checking a code is 60 per
 * 10 minutes for one IP. These counts live in memory, so each replica keeps its
 * own and they act as a cheap backstop against floods. The caps that must hold
 * across replicas (30 codes per address per 24 hours, 50 wrong guesses per
 * address per 24 hours, the 60 second cooldown and the 5 wrong tries per code)
 * are enforced from the database in `EmailCodeService`.
 *
 * Every guard carries its own limit and window in `handleRequest`, so the
 * routes need no `@Throttle` metadata and the global IP bucket keeps its
 * app-wide default. The tracker prefixes keep these buckets apart from the
 * global one, and `generateKey` already separates routes by class and handler.
 *
 * The address tracker holds a SHA-256 of the IP and the normalized address.
 * The address itself never reaches the throttler storage, a log line or a key.
 */
const ONE_HOUR_MS = hours(1);
const TEN_MINUTES_MS = minutes(10);

function clientIp(req: Record<string, unknown>): string {
  // Fails closed into one shared bucket; this should not occur behind `trust proxy`.
  return typeof req.ip === 'string' ? req.ip : 'unknown';
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

/** Asking for a code: 5 per hour for one IP and one address. */
@Injectable()
export class EmailCodeRequestAddressThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const body = req.body as { email?: unknown } | undefined;
    const normalizedAddress =
      typeof body?.email === 'string' ? normalizeEmailAddress(body.email) : '';
    const fingerprint = createHash('sha256')
      .update(`${clientIp(req)}|${normalizedAddress}`)
      .digest('hex');
    return Promise.resolve(`email-code-address:${fingerprint}`);
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
