import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { ExtractJwt, JwtFromRequestFunction, Strategy } from 'passport-jwt';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { User, UserStatus } from '../../users/entities/user.entity';
import { CurrentUserData } from '../decorators/current-user.decorator';
import { RefreshToken } from '../entities/refresh-token.entity';

const cookieExtractor: JwtFromRequestFunction = (req: Request) =>
  (req?.cookies as Record<string, string | undefined> | undefined)?.[
    'access_token'
  ] ?? null;

/**
 * The claims `AuthService.issueTokensWithRow` signs into an access token.
 *
 * ⚠️ `status` and `role` are ADVISORY ONLY. They are a snapshot taken when the
 * token was minted and can be up to one access-token TTL (15m by default) out
 * of date: a member banned, suspended, promoted or demoted a minute ago still
 * carries the old values. NOTHING may authorise on them.
 *
 * They exist for exactly two reasons, neither of which is authorisation:
 *   - the shape check below and in `AuthService.verifyAccessToken`, which
 *     rejects a token minted for a different purpose (a refresh token carries
 *     only `{ sub, jti }`) from ever being replayed as an access token;
 *   - `ChatGateway.authenticate`, which has no request to hang `req.user` off
 *     and reads `status` at the handshake. That is safe only because every
 *     moderation path calls `revokeAllForUser`, whose `USER_SESSION_REVOKED`
 *     event force-drops the member's sockets. Removing that emit would reopen
 *     a 15-minute stale-privilege window on the socket path.
 *
 * The authoritative read is `validate()` below: one indexed PK lookup per
 * request, so a ban takes effect on the very next request. Any new consumer
 * must do the same rather than trusting these claims.
 */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  /** Advisory snapshot. Re-read `users.status` before acting on it. */
  status: string;
  /** Advisory snapshot. Re-read `users.role` before acting on it. */
  role: string;
  /**
   * The SESSION this token was minted for: the `refresh_tokens.family_id` of
   * the sign-in it descends from. Unlike `status` and `role` this claim is NOT
   * advisory, because it is not a snapshot of anything mutable. A family id is
   * assigned once at sign-in and never changes, so the value is as true fifteen
   * minutes later as it was at mint time. `validate()` below still re-reads
   * whether that family is LIVE, which is the mutable part.
   *
   * It carries the family rather than the `refresh_tokens` row id on purpose.
   * A row is a credential that rotation replaces roughly every fifteen minutes,
   * so a row id names something the holder may already have rotated out of. The
   * family names the session itself, which is what a member recognises as "this
   * laptop" and what `AccountService` addresses for the security page.
   *
   * OPTIONAL, and it must stay optional. Access tokens minted before the deploy
   * that added this claim carry no `sid`, and they stay valid for the rest of
   * their access TTL. See the legacy note in `validate()`.
   */
  sid?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('auth.jwtAccessSecret'),
      // Pin verification to the algorithm we sign access tokens with (HS256).
      // Without an allowlist passport-jwt accepts whatever `alg` the token
      // header names — the JWT algorithm-confusion class of bug. Our secret is
      // a symmetric string so only the HMAC family is reachable, but pinning is
      // cheap defence in depth and future-proofs against a key-type change.
      algorithms: ['HS256'],
    });
  }

  async validate(payload: AccessTokenPayload): Promise<CurrentUserData> {
    // Signature + access-secret already verified by passport-jwt. This is a
    // shape check: reject anything missing the full access-token claim set so a
    // refresh token (only `{ sub, jti }`) — or any other token minted for a
    // different purpose — can never be replayed as an access token even if the
    // secrets were ever misconfigured to overlap.
    if (
      !payload?.sub ||
      !payload?.email ||
      !payload?.status ||
      !payload?.role
    ) {
      throw new UnauthorizedException('Malformed access token payload');
    }
    // `sid` is absent on legacy tokens (see `isSessionLive`), so its absence is
    // not a shape failure. A `sid` that is present but is not a string is: it
    // would silently skip the session check below, and a claim that can be
    // disabled by sending the wrong type is not a check at all.
    if (payload.sid !== undefined && typeof payload.sid !== 'string') {
      throw new UnauthorizedException('Malformed access token payload');
    }

    // Re-read status/role from the DB rather than trusting the claims. They are
    // baked in at sign time, so a token minted before a ban or a demotion would
    // otherwise carry the old privileges until it expired — moderation would
    // silently lag by the access-token TTL. One indexed PK lookup per request is
    // the cost of making a ban take effect immediately.
    //
    // The session-liveness check rides alongside it rather than after it: both
    // are single indexed lookups, and issuing them together means the second one
    // costs a pool slot instead of a round trip.
    const [user, isSessionLive] = await Promise.all([
      this.users.findOne({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          status: true,
          role: true,
          suspendedUntil: true,
          restricted: true,
          restrictedUntil: true,
        },
      }),
      this.isSessionLive(payload.sid),
    ]);
    if (!user) {
      // Deleted user holding a still-valid token.
      throw new UnauthorizedException('User no longer exists');
    }
    if (!isSessionLive) {
      // "Sign out this device" revoked the refresh family this token belongs
      // to, so the token itself is now a credential for a session that no
      // longer exists. Rejecting it here is what makes the promise on the
      // security page true: before this check the revoked device kept reading
      // DMs and posting on its already-issued access token for the rest of the
      // access TTL, and only its socket was dropped.
      throw new UnauthorizedException('Session has been signed out');
    }

    const status = await this.liftExpiredSuspension(user);
    const restricted = await this.liftExpiredRestriction(user);

    return {
      userId: user.id,
      email: user.email,
      status,
      role: user.role,
      restricted,
      sessionId: payload.sid,
    };
  }

  /**
   * Is the refresh-token FAMILY this access token was minted for still alive?
   *
   * An ABSENT `sid` answers yes. A token with no `sid` can only be one this
   * server minted before the deploy that added the claim: the signature proves
   * it came from us, and every path that mints an access token now sets `sid`.
   * Such a token expires within one access TTL (15 minutes by default), so the
   * gap closes itself and nobody is signed out by the deploy landing. Treating
   * a missing claim as a rejection instead would log out every signed-in member
   * at deploy time, which is a worse outcome than a fifteen-minute tail on a
   * revocation that only reaches devices already holding a valid token.
   *
   * A `sid` that IS present is checked, and a family that is revoked or expired
   * fails. One indexed lookup on `IDX_refresh_tokens_family_id`, bounded by
   * `exists` so Postgres can stop at the first matching row.
   *
   * Liveness matches what `AccountService.listSessions` calls a live session,
   * deliberately: a device the security page lists is a device that can still
   * make requests, and one it does not list cannot. Both conditions are needed.
   * `revoked_at IS NULL` alone would keep a family that had simply run out its
   * 30-day life usable for the 30 further days the purge job waits before
   * deleting the rows.
   */
  private async isSessionLive(sessionId: string | undefined): Promise<boolean> {
    if (!sessionId) {
      return true;
    }
    return this.refreshTokens.exists({
      where: {
        familyId: sessionId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
  }

  /**
   * Lazy expiry for moderation suspensions, with write-through.
   *
   * A suspension ends by the clock, and this is the only thing that ends it
   * (there is no cron sweep). Writing the row back — rather than merely
   * treating the member as active for this request — matters because
   * everything else in the codebase reads `users.status` directly: the member
   * directory, the feed, member refs, cohost/invite eligibility, the chat
   * handshake. Without the write-back a member whose suspension had lapsed
   * could sign in and use the site while remaining invisible to everyone else,
   * which is a worse and far more confusing failure than staying suspended.
   *
   * `suspendedUntil === null` while suspended is a permanent ban and never
   * expires — that is the whole distinction between `ban` and `suspend`.
   *
   * The UPDATE runs only on the rare request that first observes a lapsed
   * suspension; every other request costs the one PK lookup it already did.
   */
  private async liftExpiredSuspension(user: User): Promise<UserStatus> {
    if (
      user.status !== UserStatus.Suspended ||
      user.suspendedUntil === null ||
      user.suspendedUntil > new Date()
    ) {
      return user.status;
    }

    await this.users.update(
      // Conditional on still being suspended so a concurrent moderator action
      // (a fresh suspension landing between the read above and this write)
      // is not clobbered by a stale expiry decision.
      { id: user.id, status: UserStatus.Suspended },
      { status: UserStatus.Active, suspendedUntil: null },
    );

    return UserStatus.Active;
  }

  /**
   * Lazy expiry for the `restrict` moderation action, with write-through —
   * the exact `liftExpiredSuspension` pattern, applied to the lighter
   * `restricted`/`restrictedUntil` pair instead of `status`/`suspendedUntil`.
   *
   * Unlike a suspension, a restriction never has a `null` (permanent) expiry —
   * `AccountEnforcementService.enforceAgainstUser` always sets one — so this
   * has no "ban" case to skip: every restriction ends by the clock.
   */
  private async liftExpiredRestriction(user: User): Promise<boolean> {
    if (
      !user.restricted ||
      user.restrictedUntil === null ||
      user.restrictedUntil > new Date()
    ) {
      return user.restricted;
    }

    await this.users.update(
      // Conditional on still being restricted so a concurrent moderator action
      // (a fresh restriction landing between the read above and this write) is
      // not clobbered by a stale expiry decision.
      { id: user.id, restricted: true },
      { restricted: false, restrictedUntil: null },
    );

    return false;
  }
}
