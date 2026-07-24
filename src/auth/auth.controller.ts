import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Request, Response } from 'express';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  setAuthCookies,
  clearAuthCookies,
  clearCsrfCookie,
  clearOAuthStateCookie,
} from './auth-cookies';
import { AuthService, GoogleUserInput } from './auth.service';
import {
  CurrentUser,
  CurrentUserData,
} from './decorators/current-user.decorator';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { OAuthCallbackFilter } from './filters/oauth-callback.filter';
import { Public } from './decorators/public.decorator';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { decodeOAuthState } from './oauth-state';
import { resolvePostLoginRedirect, signInErrorUrl } from './safe-redirect';
import { Throttle, seconds } from '@nestjs/throttler';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';

@LockdownExempt()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
  ) {}

  private cookieOpts() {
    return {
      secure: this.config.get<string>('app.nodeEnv') === 'production',
      domain: this.config.get<string>('auth.cookieDomain') || undefined,
    };
  }

  // Constant-time nonce comparison (both are our own hex strings of equal
  // length; the length guard avoids timingSafeEqual throwing on a mismatch).
  private nonceMatches(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ab, bb);
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth(): void {
    // GoogleAuthGuard redirects to Google's consent screen; this body never runs.
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @UseFilters(OAuthCallbackFilter)
  @Get('google/callback')
  async googleCallback(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const state = decodeOAuthState(
      typeof req.query.state === 'string' ? req.query.state : undefined,
    );
    const cookieNonce = req.cookies?.['oauth_state'];
    // The nonce cookie is single-use: clear it now regardless of the outcome.
    clearOAuthStateCookie(res, this.cookieOpts());

    // CSRF / fixation gate: the nonce echoed in `state` must match the one we
    // stored in the httpOnly cookie when the flow began. Reject on missing or
    // mismatched nonce before trusting anything else in `state`.
    if (
      !state.nonce ||
      typeof cookieNonce !== 'string' ||
      !this.nonceMatches(state.nonce, cookieNonce)
    ) {
      res.redirect(
        signInErrorUrl(
          this.config.getOrThrow<string>('app.frontendUrl'),
          'invalid_state',
        ),
      );
      return;
    }

    const profile = req.user as GoogleUserInput;
    const { invite, redirect, ageAttested, termsVersion } = state;

    let user: User;
    try {
      user = await this.authService.validateOrCreateGoogleUser(
        profile,
        invite,
        {
          ageAttested,
          termsVersion,
        },
      );
    } catch (err) {
      if (err instanceof SignupRejectedError) {
        res.redirect(
          signInErrorUrl(
            this.config.getOrThrow<string>('app.frontendUrl'),
            err.reason,
          ),
        );
        return;
      }
      throw err;
    }

    const tokens = await this.authService.issueTokens(
      user,
      req.headers['user-agent'],
    );
    setAuthCookies(res, tokens, this.cookieOpts());
    // Honor the validated post-login redirect; fall back to the default landing
    // page when it is absent or fails the open-redirect safety checks.
    const frontendUrl = this.config.getOrThrow<string>('app.frontendUrl');
    res.redirect(resolvePostLoginRedirect(redirect, frontendUrl));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const raw = req.cookies?.['refresh_token'];
    if (!raw) {
      clearAuthCookies(res, this.cookieOpts());
      throw new UnauthorizedException('Missing refresh token');
    }
    let tokens;
    try {
      tokens = await this.authService.rotateRefreshToken(
        raw,
        req.headers['user-agent'],
      );
    } catch (err) {
      // Spec §3: on an invalid/expired/revoked/reused refresh token, 401 AND
      // clear the cookies so the client isn't stuck looping on a poisoned token.
      clearAuthCookies(res, this.cookieOpts());
      throw err;
    }
    setAuthCookies(res, tokens, this.cookieOpts());
    return { ok: true };
  }

  // @Public so an EXPIRED access token still logs the user out (JwtAuthGuard is
  // skipped) — but it stays a POST behind the global CsrfGuard, so it remains
  // CSRF-protected. Best-effort: revoke the refresh row if we can, ALWAYS clear
  // cookies, ALWAYS return ok.
  @Public()
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const raw = req.cookies?.['refresh_token'];
    if (raw) {
      try {
        await this.authService.revokeRefreshToken(raw);
      } catch {
        // Best-effort: a bad/unknown refresh token must not block logout.
      }
    }
    clearAuthCookies(res, this.cookieOpts());
    clearCsrfCookie(res);
    return { ok: true };
  }

  // Global sign-out: revoke every live refresh token for the current user, then
  // clear this device's cookies. Authenticated (NOT @Public) so we know who to
  // revoke; POST keeps it CSRF-protected.
  @Post('logout-all')
  async logoutAll(
    @CurrentUser() current: CurrentUserData,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.authService.revokeAllForUser(current.userId);
    clearAuthCookies(res, this.cookieOpts());
    clearCsrfCookie(res);
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() current: CurrentUserData) {
    const user = await this.usersService.findByIdWithProfile(current.userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    return {
      id: user.id,
      // From the JWT (re-read from the DB every request by JwtStrategy), not the
      // entity: `User.email` is `select: false`, and `findByIdWithProfile` is
      // also used by a public invite view that must not load it.
      email: current.email,
      status: user.status,
      role: user.role,
      // NULL for accounts created before the 18+ gate shipped — the frontend
      // contract (AuthUser.ageAttestedAt) already expects a nullable ISO string.
      ageAttestedAt: user.ageAttestedAt?.toISOString() ?? null,
      profile: user.profile ?? null,
    };
  }
}
