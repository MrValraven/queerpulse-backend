import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
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
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { OAuthCallbackFilter } from './filters/oauth-callback.filter';
import { Public } from './decorators/public.decorator';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { decodeOAuthState } from './oauth-state';
import { resolvePostLoginRedirect, signInErrorUrl } from './safe-redirect';
import { Throttle, seconds } from '@nestjs/throttler';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { toImageUrl } from '../common/image-url';

// This controller inherits the app-wide `defaultVersion: '1'`, so its routes
// answer at `/v1/auth/...` — which is where the SPA's versioned API client
// (src/shared/api/client.ts) sends `me` and `logout-all`.
//
// The exceptions carry `@Version(VERSION_NEUTRAL)` per-method and keep their
// fixed, unversioned paths:
//   - the Google OAuth callback URL is registered in Google Cloud, and the SPA
//     hits `/auth/google` and `/auth/refresh` directly (unprefixed);
//   - `logout` MUST answer at `/auth/logout`, not `/v1/auth/logout`. The refresh
//     token cookie is scoped to `path=/auth` (see `auth-cookies.ts`), so a
//     browser only attaches it to request paths under `/auth`. A versioned
//     `/v1/auth/logout` never receives the cookie, so `revokeRefreshToken`
//     (which revokes the row AND force-disconnects the member's live sockets via
//     `USER_SESSION_REVOKED`) silently no-ops. Keeping logout neutral puts it
//     back inside the cookie scope, exactly like `refresh`.
@ApiTags('auth')
@LockdownExempt()
@Controller({ path: 'auth' })
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

  @ApiOperation({ summary: 'Begin Google OAuth sign-in.' })
  @ApiFoundResponse({ description: "Redirect to Google's consent screen." })
  @Version(VERSION_NEUTRAL)
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth(): void {
    // GoogleAuthGuard redirects to Google's consent screen; this body never runs.
  }

  @ApiOperation({ summary: 'Handle the Google OAuth callback.' })
  @ApiFoundResponse({
    description:
      'Redirect back to the frontend — signed in (auth cookies set) on success, or to the sign-in error page otherwise.',
  })
  @Version(VERSION_NEUTRAL)
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
    const cookieNonce = (
      req.cookies as Record<string, string | undefined> | undefined
    )?.['oauth_state'];
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

  @ApiOperation({ summary: 'Rotate the refresh token and reset auth cookies.' })
  @ApiCreatedResponse({
    description: 'Tokens rotated; fresh auth cookies set.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, expired, revoked, or reused refresh token.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  @Version(VERSION_NEUTRAL)
  @Public()
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const raw = (
      req.cookies as Record<string, string | undefined> | undefined
    )?.['refresh_token'];
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
  @ApiOperation({ summary: 'Log out this device and clear auth cookies.' })
  @ApiCreatedResponse({ description: 'Logged out; auth cookies cleared.' })
  @Version(VERSION_NEUTRAL)
  @Public()
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const raw = (
      req.cookies as Record<string, string | undefined> | undefined
    )?.['refresh_token'];
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
  @ApiOperation({ summary: 'Log out every device for the current user.' })
  @ApiCookieAuth('access_token')
  @ApiCreatedResponse({
    description: 'All sessions revoked; this device signed out.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
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

  @ApiOperation({ summary: 'Get the currently authenticated user.' })
  @ApiCookieAuth('access_token')
  @ApiOkResponse({ description: 'The current user with their profile.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('me')
  async me(@CurrentUser() current: CurrentUserData) {
    const user = await this.usersService.findByIdWithProfile(current.userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    // A suspended/banned member is locked out of every gated route, so the
    // account-suspended/banned page has no authed endpoint to call for the
    // reason — it rides on `me` (JWT-only) instead. Null for everyone else.
    const [suspensionInfo, staffRoles] = await Promise.all([
      this.authService.suspensionInfoFor(user),
      // Additive functional grants (STAFF_ROLES) on top of `role` — the
      // frontend capability layer (useMyStaffRoles) reads this. Empty array
      // for a member holding none; admins are a superset resolved client-side.
      this.authService.staffRolesFor(user.id),
    ]);
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
      // NULL only while a brand-new member is still mid-onboarding. The frontend
      // gate reads this to keep an already-onboarded member out of the wizard.
      onboardedAt: user.onboardedAt?.toISOString() ?? null,
      // Resolve the avatar the SAME way every other endpoint does (`toImageUrl`):
      // an uploaded avatar is stored as a bare storage KEY (`avatars/<id>/<uuid>.jpg`),
      // which is not directly fetchable — it must become a `${API_URL}/files/<key>`
      // URL. Returning the raw entity here meant `/auth/me` handed the frontend the
      // bare key, and `<img src="avatars/...">` resolved it relative to the page
      // origin → a broken image for every uploaded photo. Google avatars are already
      // absolute `https://` URLs, so `toImageUrl` passes them through untouched.
      profile: user.profile
        ? { ...user.profile, avatarUrl: toImageUrl(user.profile.avatarUrl) }
        : null,
      staffRoles,
      // { suspendedUntil, suspension } — both null unless the member is suspended.
      ...suspensionInfo,
    };
  }

  @ApiOperation({
    summary:
      'Mark the current member as having finished onboarding and agreed to the community guidelines.',
  })
  @ApiCookieAuth('access_token')
  @ApiCreatedResponse({
    description:
      'Onboarding recorded; returns the onboarding + guidelines-agreement stamps.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Post('onboarding/complete')
  async completeOnboarding(
    @CurrentUser() current: CurrentUserData,
    @Body() dto: CompleteOnboardingDto,
  ): Promise<{
    onboardedAt: string;
    guidelinesAcceptedAt: string;
    guidelinesVersion: string;
  }> {
    const result = await this.usersService.markOnboarded(current.userId, {
      guidelinesVersion: dto.guidelinesVersion,
    });
    return {
      onboardedAt: result.onboardedAt.toISOString(),
      guidelinesAcceptedAt: result.guidelinesAcceptedAt.toISOString(),
      guidelinesVersion: result.guidelinesVersion,
    };
  }
}
