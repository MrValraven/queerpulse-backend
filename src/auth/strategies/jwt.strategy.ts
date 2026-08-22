import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { ExtractJwt, JwtFromRequestFunction, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { User, UserStatus } from '../../users/entities/user.entity';
import { CurrentUserData } from '../decorators/current-user.decorator';

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
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
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

    // Re-read status/role from the DB rather than trusting the claims. They are
    // baked in at sign time, so a token minted before a ban or a demotion would
    // otherwise carry the old privileges until it expired — moderation would
    // silently lag by the access-token TTL. One indexed PK lookup per request is
    // the cost of making a ban take effect immediately.
    const user = await this.users.findOne({
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
    });
    if (!user) {
      // Deleted user holding a still-valid token.
      throw new UnauthorizedException('User no longer exists');
    }

    const status = await this.liftExpiredSuspension(user);
    const restricted = await this.liftExpiredRestriction(user);

    return {
      userId: user.id,
      email: user.email,
      status,
      role: user.role,
      restricted,
    };
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
