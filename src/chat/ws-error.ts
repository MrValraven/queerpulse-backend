import { WsException } from '@nestjs/websockets';

/**
 * The full set of codes a `/chat` gateway `exception` frame can carry.
 *
 * This is the shared contract with the frontend (`queerpulse/src/shared/
 * contracts/realtime.ts`): every deliberate refusal this gateway makes maps
 * to exactly one of these, and the client branches on `code` as the source of
 * truth, treating `message` text as display copy only (ENG-206/ENG-220).
 * Widening this union is a contract change and has to happen on both sides
 * at once.
 *
 * - `UNAUTHORIZED`: the credential itself is missing, malformed, or its
 *   signature does not verify. Re-authenticating (a token refresh) is the
 *   right client response.
 * - `TOKEN_EXPIRED`: the handshake token's own `exp` was reached while the
 *   socket was open (`scheduleTokenExpiry`). A refresh plus reconnect is
 *   the expected, routine response.
 * - `SESSION_REVOKED`: the credential verified, but the session behind it
 *   is gone (an inactive membership, a signed-out refresh-token family via
 *   `assertSessionLive`, or a forced disconnect via
 *   `ChatGateway.handleSessionRevoked`). Kept separate from `UNAUTHORIZED` so
 *   the client can tell "your credential is bad" apart from "you were signed
 *   out" without parsing prose.
 * - `PLATFORM_LOCKED`: an admin-authored refusal during lockdown. Carries a
 *   human-readable `message` the member is MEANT to read, unlike every other
 *   code here.
 * - `RATE_LIMITED`: a token bucket (per-event or the handshake bucket,
 *   ENG-211) was empty. Retryable after backing off.
 * - `FORBIDDEN`: the caller is authenticated and their session is live, but
 *   the specific action is refused (e.g. `conversation:join` on a thread
 *   they are not a live participant of).
 * - `NOT_FOUND`: the target of the action does not exist, or is not visible
 *   to this caller, which is indistinguishable from the caller's point of
 *   view.
 * - `BAD_REQUEST`: malformed input, whether a `ValidationPipe` failure or
 *   any other 4xx `HttpException` that isn't one of the more specific codes
 *   above.
 * - `SERVER_ERROR`: an infrastructure failure (a DB error mid-handshake, a
 *   presence broadcast failure, an unrecognised thrown value). Every
 *   anticipated way a CLIENT can get this wrong (a bad token, a malformed
 *   payload, too many requests) is mapped to one of the specific codes
 *   above instead, deliberately, so `SERVER_ERROR` is always logged and
 *   reported (ENG-212/ENG-221) without a flooding or malformed client
 *   burning the Sentry quota for its own mistakes.
 */
export type ChatWsErrorCode =
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'SESSION_REVOKED'
  | 'PLATFORM_LOCKED'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR';

/** The wire shape of every `exception` frame this gateway emits. */
export interface ChatWsErrorFrame {
  status: 'error';
  code: ChatWsErrorCode;
  /** Display copy, and nothing else: a string for every refusal this gateway
   *  raises itself, or the `ValidationPipe`'s class-validator error array for
   *  a malformed payload. A machine-readable DOMAIN code never rides in here,
   *  it travels in {@link ChatWsErrorFrame.domainCode}. */
  message: unknown;
  /** ENG-242: the domain-level code some refusals carry alongside the coarse
   *  transport `code` above (e.g. `'ACCOUNT_RESTRICTED'` from
   *  `NotRestrictedGuard`). Its own field rather than something folded into
   *  `message`, so `message` keeps ONE shape across every refusal and a client
   *  never has to test which kind it received before reading it. */
  domainCode?: string;
  statusCode?: number;
}

/**
 * The single place that builds a {@link ChatWsErrorFrame}. Both
 * `ChatWsException` and `WsAllExceptionsFilter` route through this so an
 * `exception` frame's shape cannot drift between the two call sites. The
 * `statusCode` and `domainCode` keys are left off the object entirely when
 * absent (JSON drops an explicit `undefined` the same way over the wire either
 * way, but omitting them keeps object-equality assertions in tests honest
 * about what is actually sent).
 */
export function buildChatWsErrorFrame(
  code: ChatWsErrorCode,
  message: unknown,
  statusCode?: number,
  domainCode?: string,
): ChatWsErrorFrame {
  const frame: ChatWsErrorFrame = { status: 'error', code, message };
  if (statusCode !== undefined) {
    frame.statusCode = statusCode;
  }
  if (domainCode !== undefined) {
    frame.domainCode = domainCode;
  }
  return frame;
}

/**
 * Every DELIBERATE refusal this gateway makes throws one of these, instead
 * of a bare `WsException` (which the filter now treats as an unclassified
 * `BAD_REQUEST`, see `WsAllExceptionsFilter`). Carrying the code on the
 * exception itself, and on the frame it builds, lets `handleConnection` and
 * `WsAllExceptionsFilter` both branch on `instanceof ChatWsException`
 * without re-parsing the error payload.
 */
export class ChatWsException extends WsException {
  readonly code: ChatWsErrorCode;
  readonly statusCode?: number;

  constructor(code: ChatWsErrorCode, message: unknown, statusCode?: number) {
    super(buildChatWsErrorFrame(code, message, statusCode));
    this.code = code;
    this.statusCode = statusCode;
  }
}
