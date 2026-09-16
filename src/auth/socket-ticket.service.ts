import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { UserStatus } from '../users/entities/user.entity';

/** `st_` marks the string as a socket ticket at a glance in logs. It is
 *  never itself a JWT: it has no dots and cannot be decoded by
 *  `jwt.verifyAsync`, which is the whole point. See
 *  {@link SocketTicketService}'s own doc for why that makes it structurally
 *  useless as a bearer credential anywhere else in the app. */
const SOCKET_TICKET_PREFIX = 'st_';

/** 256 bits of entropy for the random half of the ticket, comfortably past
 *  what a 30-second, single-use, rate-limited secret needs to resist guessing
 *  before it either redeems or expires. */
const SOCKET_TICKET_ENTROPY_BYTES = 32;

/**
 * How long a minted ticket stays redeemable. Deliberately short: this is
 * separate from the socket-extension window itself (that comes from
 * `accessTtlMs`, passed into {@link SocketTicketService.mint} by the caller
 * and baked into the MINTED RECORD as the `exp` `session:reauth` will grant
 * on success). This value only bounds how long the ONE-TIME SECRET is
 * allowed to sit unredeemed. A member's browser mints, then emits
 * `session:reauth`, in the same tick of the event loop for all practical
 * purposes; 30s is generous headroom for a slow network while still keeping
 * a leaked ticket's usable window short (see the class doc for what a stolen
 * ticket actually buys an attacker).
 */
const SOCKET_TICKET_TTL_MS = 30_000;

/** What `mint` returns to the HTTP caller: the plaintext ticket (stored only
 *  as a hash server-side, mirroring `AuthService.hashToken`'s refresh/reauth
 *  token pattern) and how long it stays redeemable. */
export interface SocketTicketMintResult {
  ticket: string;
  ttlMs: number;
}

/**
 * What a successful {@link SocketTicketService.redeem} hands back to
 * `ChatGateway.handleReauth`, shaped so it can be fed straight into the
 * gateway's existing `assertClaimsAdmitted(payload: AccessTokenClaims)`,
 * exactly like a freshly-verified JWT's claims would be. `status` is the
 * DB-fresh snapshot `JwtStrategy.validate` (or `AuthController`'s
 * `@CurrentUser()`) read at MINT time; redemption reuses that snapshot as-is
 * rather than reading it again. It is precisely as fresh as a real access
 * token's own `status` claim
 * would be at that same mint time: `assertClaimsAdmitted` only ever reads
 * that claim off the token's own payload too (see its doc), so this carries
 * the same mint-time-snapshot guarantee a token-based reauth already has.
 */
export interface SocketTicketRecord {
  userId: string;
  sessionId?: string;
  status: UserStatus;
  /** Standard JWT-style expiry (seconds since epoch) this ticket will grant
   *  the socket's OWN expiry timer on a successful redemption, computed at
   *  mint time as `now + accessTtlMs`, the same span a freshly-minted access
   *  token would carry. */
  exp: number;
}

interface SocketTicketEntry {
  record: SocketTicketRecord;
  /** Epoch ms this entry stops being redeemable. Distinct from
   *  `record.exp`; see {@link SOCKET_TICKET_TTL_MS}. */
  expiresAt: number;
}

/**
 * Mint-and-redeem store for `session:reauth`'s single-use socket ticket
 * (ENG-219, the frontend half). `httpOnly access_token` cookies never reach
 * JavaScript by design (`auth-cookies.ts`), so the browser cannot put a real
 * access token in a `session:reauth` frame the way a non-browser client's
 * `token` field still can. A ticket is the substitute: minted over an
 * authenticated, CSRF-protected HTTP call (`AuthController.mintSocketTicket`)
 * and redeemed exactly once, over the socket, by `ChatGateway.handleReauth`.
 *
 * ## Storage choice
 *
 * An in-memory, process-local Map. A ticket lives for at most
 * {@link SOCKET_TICKET_TTL_MS} (30s) and is consumed by
 * the very next `session:reauth` frame the SAME browser tab sends. There is
 * no redirect and no cross-request survival, unlike a refresh token or a
 * reauth token (`AccountReauthToken`, which DOES survive an OAuth redirect
 * and so DOES need a row). A DB row would buy durability this value never
 * needs, at the cost of a write plus a delete on the hot path of every
 * socket renewal. This mirrors `ChatGateway`'s own already-documented
 * SINGLE-REPLICA assumption (its in-memory `PresenceService`, its per-socket
 * `TokenBucketLimiter` buckets, `chat-single-instance.guard.ts` asserting it
 * at boot): there is no Redis adapter configured, so every one of those is
 * already process-local, and this store adds no new deployment constraint on
 * top of what already exists.
 *
 * ## Single-use redemption
 *
 * `redeem` deletes the entry from the map as its very first act, before
 * checking expiry or the caller's identity. Node is single-threaded and
 * `redeem` awaits nothing between the lookup and the delete, so there is no
 * interleaving window in which two calls (even two `session:reauth` frames
 * arriving back-to-back on the same tick) can both observe the entry still
 * present. The SECOND caller's `this.ticketsByHash.get(hash)` sees nothing,
 * by construction, regardless of which call "wins" the race. This is the
 * entire mechanism that makes a second redemption of the same ticket fail;
 * nothing else about the class enforces it.
 *
 * Deleting unconditionally, even when the redemption goes on to fail its own
 * expiry/user check, is deliberate: a ticket that has been PRESENTED once is
 * spent, whether or not that presentation succeeded. Leaving a
 * failed-but-still-valid attempt redeemable would let it be retried
 * (probed) indefinitely for the rest of its TTL.
 *
 * ## Cleanup
 *
 * `mint` sweeps every already-expired entry off the map before inserting the
 * new one (`sweepExpired`). No background timer is needed to keep this
 * bounded: entries live at most 30s, minting is rate-limited
 * (`SocketTicketThrottlerGuard`), and the sweep on every mint call is enough
 * to keep the map from accumulating stale rows indefinitely. Nothing else
 * ever grows it.
 *
 * ## Sharing across two modules without a DI import
 *
 * `ChatGateway` (chat.gateway.ts) redeems tickets `AuthController`
 * (auth.controller.ts) mints, and those two live in `AuthModule` and
 * `ChatModule` respectively. `ChatModule` deliberately does NOT import
 * `AuthModule` (see that module's own doc: it would pull
 * membership/vouch/connections/media-crops into the chat DI graph for what
 * is elsewhere a single read-side entity registration). Threading a second
 * cross-module import through `ChatModule` for this one small,
 * single-instance service would be exactly that regression. Instead this
 * file exports a process-wide singleton (`socketTicketService`, below) that
 * both sides import directly. `AuthModule` still wires it into Nest's DI
 * container for `AuthController` via a `useValue` provider, so the
 * controller's constructor injection stays idiomatic, while `ChatGateway`
 * imports the SAME object directly, bypassing DI entirely on that side. Both
 * call sites therefore share the one Map. This mirrors `ChatGateway`'s own
 * `TokenBucketLimiter` fields (`ws-rate-limiter.ts`): plain classes,
 * instantiated directly, with no DI, just shared across two files instead of
 * scoped to one.
 */
@Injectable()
export class SocketTicketService {
  private readonly ticketsByHash = new Map<string, SocketTicketEntry>();

  /**
   * Mint a fresh ticket for `userId`. `status` and `sessionId` should be the
   * DB-fresh values the minting HTTP request itself already read (from
   * `@CurrentUser()`, populated by `JwtStrategy.validate`'s own re-read).
   * See {@link SocketTicketRecord}'s doc for why that snapshot is exactly as
   * fresh as a real access token's own claims. `accessTtlMs` is the caller's
   * `auth.jwtAccessTtlMs`, the same span a freshly-minted access token, or a
   * token-based reauth, would grant. It is baked into the record as an
   * absolute `exp` now, at mint time, so redemption never has to re-derive
   * it.
   */
  mint(
    userId: string,
    sessionId: string | undefined,
    status: UserStatus,
    accessTtlMs: number,
  ): SocketTicketMintResult {
    this.sweepExpired();
    const ticket = `${SOCKET_TICKET_PREFIX}${randomBytes(
      SOCKET_TICKET_ENTROPY_BYTES,
    ).toString('hex')}`;
    const now = Date.now();
    this.ticketsByHash.set(this.hashTicket(ticket), {
      record: {
        userId,
        sessionId,
        status,
        exp: Math.floor((now + accessTtlMs) / 1000),
      },
      expiresAt: now + SOCKET_TICKET_TTL_MS,
    });
    return { ticket, ttlMs: SOCKET_TICKET_TTL_MS };
  }

  /**
   * Redeem `ticket` for `expectedUserId`, the id of the socket presenting
   * it. That id is the ALREADY-AUTHENTICATED identity
   * `ChatGateway.handleReauth` reads off `client.data.userId`, never off the
   * ticket or the payload itself (mirrors the token path's own
   * `payload.sub === userId` check).
   *
   * Returns `null` for every refusal shape: unknown (never existed, already
   * redeemed, or swept after expiry), expired, or minted for a different
   * user. These are deliberately collapsed to one outcome, exactly like the
   * token path's `verifyAccessToken` collapses every verification failure to
   * a single `UNAUTHORIZED`. Which of the three it was is not information a
   * caller, legitimate or not, needs back.
   */
  redeem(ticket: string, expectedUserId: string): SocketTicketRecord | null {
    const hash = this.hashTicket(ticket);
    const entry = this.ticketsByHash.get(hash);
    if (!entry) {
      return null;
    }
    // Single-use: see the class doc's "Single-use redemption" section for
    // why deleting FIRST, before either check below, is the entire
    // correctness mechanism.
    this.ticketsByHash.delete(hash);
    if (entry.expiresAt <= Date.now()) {
      return null;
    }
    if (entry.record.userId !== expectedUserId) {
      return null;
    }
    return entry.record;
  }

  /** Drops every entry whose redemption window has already lapsed. Run at
   *  the start of every `mint`; see the class doc's "Cleanup" section for
   *  why nothing else (no background timer) is needed to keep this map
   *  bounded. Exposed (not `private`) only so a test can assert the sweep
   *  actually removes a stale row rather than merely trusting `mint`'s
   *  side-effect. */
  sweepExpired(now: number = Date.now()): void {
    for (const [hash, entry] of this.ticketsByHash) {
      if (entry.expiresAt <= now) {
        this.ticketsByHash.delete(hash);
      }
    }
  }

  /** Test-only: the number of entries currently held, expired or not. */
  size(): number {
    return this.ticketsByHash.size;
  }

  private hashTicket(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex');
  }
}

/**
 * The process-wide shared instance. See {@link SocketTicketService}'s
 * "Sharing across two modules without a DI import" section for exactly why
 * this exists, and why both `AuthController` (via `AuthModule`'s `useValue`
 * provider) and `ChatGateway` (via a direct import, no DI) must resolve to
 * this SAME object rather than each constructing their own.
 */
export const socketTicketService = new SocketTicketService();
