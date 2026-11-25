import { ExecutionContext, Injectable } from '@nestjs/common';
import { minutes } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { normalizeClientAddress } from '../reports/anonymous-reporter-key';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';
import { quizshowError } from './quizshow-errors';

/**
 * The limits on starting a Pulse Live device pairing (contract 5.1): a
 * screen start is 10 per 10 minutes for one IP, a helper start is 10 per
 * 10 minutes for one member.
 *
 * Nest's throttler keys by IP and answers a bare 429, so each guard picks its
 * own bucket and refuses with `quizshow_pairing_rate_limited`, which the
 * pairing screens can name (decision A24). Each guard carries its limit and
 * window in `handleRequest`, as the email code guards do, so the routes need
 * no `@Throttle` metadata: route metadata would also bind the global guard,
 * whose bare 429 would then answer first. The global bucket keeps its
 * app-wide default on these routes.
 *
 * The tracker prefixes keep these buckets apart from the global one. A
 * tracker holds a client network or a member id only; codes and poll tokens
 * never key a bucket.
 *
 * An IP bucket keys an IPv4 address whole and an IPv6 address by its /64
 * (`normalizeClientAddress`): privacy addressing rotates the host half of an
 * IPv6 address, so a full-address key would let one TV mint fresh buckets.
 */
const PAIRING_STARTS_MAX = 10;
const PAIRING_STARTS_WINDOW_MS = minutes(10);

/** Claims one pairing may make in a minute: twice a TV polling every 2 s. */
const PAIRING_CLAIMS_PER_PAIRING_MAX = 60;

/** Claims one client network may make in a minute: six TVs behind one venue network polling every 2 s. */
const PAIRING_CLAIMS_PER_NETWORK_MAX = 180;

const PAIRING_CLAIMS_WINDOW_MS = minutes(1);

/** The pairing bucket every malformed pairing id shares; the route answers those with a 404 anyway. */
const MALFORMED_PAIRING_ID = 'malformed';

const PAIRING_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bucket every unparseable client address shares. */
const UNKNOWN_CLIENT_NETWORK = 'unknown';

function clientNetwork(request: Record<string, unknown>): string {
  // An address that does not parse fails closed into one shared bucket; this
  // should not occur behind `trust proxy`.
  const rawAddress = typeof request.ip === 'string' ? request.ip : null;
  return normalizeClientAddress(rawAddress) ?? UNKNOWN_CLIENT_NETWORK;
}

function withPairingStartLimit(
  requestProps: ThrottlerRequest,
): ThrottlerRequest {
  return {
    ...requestProps,
    limit: PAIRING_STARTS_MAX,
    ttl: PAIRING_STARTS_WINDOW_MS,
    blockDuration: PAIRING_STARTS_WINDOW_MS,
  };
}

/** `POST /quizshow/device-pairings/screen`: 10 per 10 minutes for one IPv4 address or IPv6 /64. */
@Injectable()
export class QuizshowScreenPairingThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(request: Record<string, unknown>): Promise<string> {
    return Promise.resolve(`quizshow-screen-pairing:${clientNetwork(request)}`);
  }

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest(withPairingStartLimit(requestProps));
  }

  protected throwThrottlingException(): Promise<void> {
    return Promise.reject(quizshowError('quizshow_pairing_rate_limited'));
  }
}

/**
 * `POST /quizshow/device-pairings/helper`: 10 per 10 minutes for one member.
 * The route sits behind `ActiveMemberGuard`, so `request.user` is set; the IP
 * bucket is a fallback for an edge that should not occur.
 */
@Injectable()
export class QuizshowHelperPairingThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(request: Record<string, unknown>): Promise<string> {
    const user = request.user as { userId?: string } | undefined;
    if (user?.userId) {
      return Promise.resolve(`quizshow-helper-pairing:${user.userId}`);
    }
    return Promise.resolve(
      `quizshow-helper-pairing-ip:${clientNetwork(request)}`,
    );
  }

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest(withPairingStartLimit(requestProps));
  }

  protected throwThrottlingException(): Promise<void> {
    return Promise.reject(quizshowError('quizshow_pairing_rate_limited'));
  }
}

function pairingIdOf(request: Record<string, unknown>): string {
  const params = request.params as Record<string, unknown> | undefined;
  const rawPairingId = params?.pairingId;
  return typeof rawPairingId === 'string' &&
    PAIRING_ID_PATTERN.test(rawPairingId)
    ? rawPairingId.toLowerCase()
    : MALFORMED_PAIRING_ID;
}

/**
 * `POST /quizshow/device-pairings/:pairingId/claim` (contract 5.1 and 13):
 * 60 a minute for one pairing, with a loose ceiling of 180 a minute for one
 * IPv4 address or IPv6 /64.
 *
 * A TV polls every 2 s, so a venue with several TVs on one network would
 * trip an IP bucket sized for one TV. The pairing bucket is the tight one:
 * the pairing id is known only to the device that started it, and the claim
 * itself still needs the poll token, so the bucket key grants nothing. The
 * IP ceiling bounds a caller that cycles through made-up pairing ids. The
 * pairing id keys the bucket as it is; the poll token never does.
 *
 * The route carries `@SkipThrottle()`, so the global guard's bare 429 never
 * answers a claim. This guard reads no skip metadata: it runs both of its
 * buckets on every HTTP claim and refuses with `quizshow_pairing_rate_limited`.
 */
@Injectable()
export class QuizshowPairingClaimThrottlerGuard extends HttpThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (await this.shouldSkip(context)) return true;
    const generateKey = this.generateKey.bind(this);
    const isNetworkAllowed = await this.handleRequest({
      context,
      limit: PAIRING_CLAIMS_PER_NETWORK_MAX,
      ttl: PAIRING_CLAIMS_WINDOW_MS,
      blockDuration: PAIRING_CLAIMS_WINDOW_MS,
      throttler: {
        name: 'quizshow-claim-network',
        limit: PAIRING_CLAIMS_PER_NETWORK_MAX,
        ttl: PAIRING_CLAIMS_WINDOW_MS,
        ignoreUserAgents: [],
        setHeaders: true,
      },
      getTracker: (request: Record<string, unknown>) =>
        Promise.resolve(`quizshow-claim-network:${clientNetwork(request)}`),
      generateKey,
    });
    const isPairingAllowed = await this.handleRequest({
      context,
      limit: PAIRING_CLAIMS_PER_PAIRING_MAX,
      ttl: PAIRING_CLAIMS_WINDOW_MS,
      blockDuration: PAIRING_CLAIMS_WINDOW_MS,
      throttler: {
        name: 'quizshow-claim-pairing',
        limit: PAIRING_CLAIMS_PER_PAIRING_MAX,
        ttl: PAIRING_CLAIMS_WINDOW_MS,
        ignoreUserAgents: [],
        setHeaders: true,
      },
      getTracker: (request: Record<string, unknown>) =>
        Promise.resolve(`quizshow-claim-pairing:${pairingIdOf(request)}`),
      generateKey,
    });
    return isNetworkAllowed && isPairingAllowed;
  }

  protected throwThrottlingException(): Promise<void> {
    return Promise.reject(quizshowError('quizshow_pairing_rate_limited'));
  }
}
