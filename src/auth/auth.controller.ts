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
  ApiForbiddenResponse,
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
import { JoinRequestsService } from '../membership/join-requests.service';
import {
  setAuthCookies,
  clearAuthCookies,
  clearCsrfCookie,
  clearOAuthStateCookie,
  SessionCookieOpts,
} from './auth-cookies';
import { AuthService, GoogleUserInput } from './auth.service';
import {
  UnderAgeDisclosureResult,
  UnderAgeDisclosureService,
} from './under-age-disclosure.service';
import {
  CurrentUser,
  CurrentUserData,
} from './decorators/current-user.decorator';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { OAuthCallbackFilter } from './filters/oauth-callback.filter';
import { Public } from './decorators/public.decorator';
import { ActiveMemberGuard } from './guards/active-member.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { RefreshSessionThrottlerGuard } from './refresh-session-throttler.guard';
import { decodeOAuthState } from './oauth-state';
import {
  reauthFailureUrl,
  resolvePostLoginRedirect,
  resolveReauthCompletionUrl,
  signInErrorUrl,
} from './safe-redirect';
import { Throttle, seconds } from '@nestjs/throttler';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { toImageUrl } from '../common/image-url';
import {
  CURRENT_GUIDELINES_VERSION,
  CURRENT_TERMS_VERSION,
} from '../consent/policy-versions';
import { cropFor } from '../media-crops/crop-response';
import { MediaCropService } from '../media-crops/media-crops.service';

// This controller inherits the app-wide `defaultVersion: '1'`, so its routes
// answer at `/v1/auth/...` — which is where the SPA's versioned API client
// (src/shared/api/client.ts) sends `me`.
//
// This comment used to name `logout-all` here as well. That was wrong on both
// counts: the SPA never called it, and the route itself was removed on
// 2026-08-26.
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
    private readonly mediaCropService: MediaCropService,
    private readonly underAgeDisclosure: UnderAgeDisclosureService,
    // PRD-14: lets an `invite_required` rejection hand a lost status
    // token back to the applicant Google has just verified.
    private readonly joinRequestsService: JoinRequestsService,
  ) {}

  /**
   * One object for every auth-cookie call in this controller.
   *
   * The two `maxAge`s are DERIVED from the configured JWT TTLs rather than
   * hardcoded, so `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` are the single knob:
   * before this, changing `JWT_REFRESH_TTL` moved the token's expiry without
   * moving the cookie's, leaving either a cookie the browser keeps long after
   * the JWT inside it 401s, or a cookie the browser drops while the server
   * still considers the session live. `clearAuthCookies` ignores the extra
   * fields (a `maxAge` is meaningless on a deletion).
   */
  private cookieOpts(): SessionCookieOpts {
    return {
      secure: this.config.get<string>('app.nodeEnv') === 'production',
      domain: this.config.get<string>('auth.cookieDomain') || undefined,
      accessMaxAge: this.config.getOrThrow<number>('auth.jwtAccessTtlMs'),
      refreshMaxAge: this.config.getOrThrow<number>('auth.jwtRefreshTtlMs'),
    };
  }

  /**
   * The raw `refresh_token` cookie this request arrived with, read in a typed
   * way (Express types `req.cookies` as `any`). Present on `/auth/*` routes
   * only — the cookie is path-scoped to `/auth` (see `auth-cookies.ts`).
   */
  private presentingRefreshToken(req: Request): string | undefined {
    const cookies = req.cookies as
      Record<string, string | undefined> | undefined;
    return cookies?.['refresh_token'];
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
    const { invite, redirect, ageAttested, termsVersion, reauth } = state;
    const frontendUrl = this.config.getOrThrow<string>('app.frontendUrl');

    // Step-up re-auth round trip (see `OAuthState.reauth`'s doc comment).
    // Branches out BEFORE `validateOrCreateGoogleUser` — this never
    // creates/updates an account or touches session cookies, it only proves
    // the browser could complete a fresh Google login (forced via
    // `prompt=login` on the outbound leg) as the SAME member who is already
    // signed in, then mints a short-lived reauth token for them.
    if (reauth) {
      const rawAccessToken = (
        req.cookies as Record<string, string | undefined> | undefined
      )?.['access_token'];
      const currentSession = rawAccessToken
        ? await this.authService.verifyAccessToken(rawAccessToken)
        : null;
      // Resolve which account this Google login belongs to via the same
      // lookup the ordinary sign-in path uses — never by reading `googleId`
      // off a loaded `User` row (see that column's `select: false` doc
      // comment on why it has no value-reader in app code).
      const linkedUser = currentSession
        ? await this.usersService.findByGoogleId(profile.googleId)
        : null;
      if (
        !currentSession ||
        !linkedUser ||
        linkedUser.id !== currentSession.sub
      ) {
        res.redirect(reauthFailureUrl(redirect, frontendUrl, 'reauth_failed'));
        return;
      }
      const { reauthToken, expiresAt } = await this.authService.mintReauthToken(
        currentSession.sub,
      );
      res.redirect(
        resolveReauthCompletionUrl(
          redirect,
          frontendUrl,
          reauthToken,
          expiresAt,
        ),
      );
      return;
    }

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
        // PRD-14. An applicant who lost their status token has no other way
        // back: nothing is ever emailed, and they have no account to be
        // notified in. Google has just VERIFIED this address, which is the
        // only proof of ownership available anywhere in the product, so an
        // `invite_required` rejection is the right moment to hand them a fresh
        // token for their own request instead of a "you need an invite" notice.
        //
        // NOT AN ENUMERATION ORACLE: reaching here costs a full OAuth round
        // trip as the owner of the address, and an address that never applied
        // falls through to exactly the redirect it already got, so nothing
        // distinguishes "never applied" from "not a member".
        if (err.reason === 'invite_required') {
          const statusToken =
            await this.joinRequestsService.recoverStatusTokenForVerifiedEmail(
              profile.email,
            );
          if (statusToken) {
            const target = new URL('/auth/request-invite/status', frontendUrl);
            target.searchParams.set('token', statusToken);
            res.redirect(target.toString());
            return;
          }
        }
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

    // End whatever session THIS browser was already holding before starting a
    // new one. `setAuthCookies` below overwrites the `refresh_token` cookie, so
    // the old session becomes unreachable from here the moment we respond —
    // but it stayed live in the database for the full 30-day refresh lifetime,
    // and the member's security page listed it as another signed-in device.
    // Every re-login after a cleared cookie, an incognito window, or a lapsed
    // session added one more. The cookie reaches us because it is scoped to
    // `/auth` (this route) and `SameSite=Lax` survives the top-level redirect
    // back from Google.
    await this.authService.revokeSessionForToken(
      this.presentingRefreshToken(req),
    );
    const tokens = await this.authService.issueTokens(
      user,
      req.headers['user-agent'],
    );
    setAuthCookies(res, tokens, this.cookieOpts());
    // Honor the validated post-login redirect; fall back to the default landing
    // page when it is absent or fails the open-redirect safety checks.
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
  // Rate-limited per refresh CREDENTIAL, not per client IP. The old
  // `@Throttle({ limit: 10, ttl: seconds(60) })` here was IP-keyed, so behind one
  // venue's wifi or a carrier's CGNAT the eleventh renewal in a minute ACROSS
  // ALL the co-located members got a 429 on the one route a signed-in browser
  // cannot do without. `RefreshSessionThrottlerGuard` carries both the tracker
  // and its own limit; see the note on its `handleRequest` for why the limit
  // deliberately does not live in a decorator here.
  //
  // No route-level `@Throttle` remains on purpose: the global IP-keyed guard
  // therefore falls back to the app-wide default, which is what every other
  // route already lives with, instead of singling this one out as the tightest
  // IP bucket in the app.
  @UseGuards(RefreshSessionThrottlerGuard)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const raw = this.presentingRefreshToken(req);
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
    const raw = this.presentingRefreshToken(req);
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

  // REMOVED 2026-08-26: `POST /auth/logout-all` ("sign out everywhere,
  // including this device"). It had no caller: nothing in the SPA ever hit it.
  // `DELETE /account/sessions` is the member-facing session control that does
  // ship, and it means something different (sign out my OTHER devices, keep
  // this one). See the note on `AuthService.revokeAllForUser`, which survives
  // and is what a real sign-out-everywhere control should call.

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
    const [suspensionInfo, staffRoles, avatarCrops] = await Promise.all([
      this.authService.suspensionInfoFor(user),
      // Additive functional grants (STAFF_ROLES) on top of `role` — the
      // frontend capability layer (useMyStaffRoles) reads this. Empty array
      // for a member holding none; admins are a superset resolved client-side.
      this.authService.staffRolesFor(user.id),
      // Single-key batched lookup (mirrors every other surface's
      // `MediaCropService.getMany` usage) — a lone GET so `me` still fires one
      // extra query at most, never per-field.
      this.mediaCropService.getMany(
        user.profile?.avatarUrl ? [user.profile.avatarUrl] : [],
      ),
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
        ? {
            // EXPLICIT allowlist, never a spread of the entity. Spreading
            // `user.profile` shipped every column on `profiles` to the
            // member — including `verifiedBy` (the verifying admin's internal
            // user id), `hiddenUntil`, `privateNetwork`, `featuredConsent`,
            // `discoverableIdentities` — and silently added any column a
            // future migration introduces. These six fields are the whole
            // `AuthUser['profile']` contract the SPA declares
            // (`features/auth/api/auth.api.ts`); richer profile data has its
            // own endpoint (`GET /profiles/:slug` -> `toFullProfile`).
            slug: user.profile.slug,
            firstName: user.profile.firstName,
            lastName: user.profile.lastName,
            pronouns: user.profile.pronouns,
            avatarUrl: toImageUrl(user.profile.avatarUrl),
            avatarCrop: cropFor(user.profile.avatarUrl, avatarCrops),
          }
        : null,
      staffRoles,
      /**
       * The re-acceptance signal (ID-14). Hand-mapped like every other field
       * here, never a spread.
       *
       * `users.terms_version` / `guidelines_version` were written once at
       * signup and then never read again, so a member could be moderated under
       * a rule added after they joined with nothing on record showing they had
       * ever seen it. Pairing what the member has on file with what is
       * currently in effect is the whole signal the frontend gate needs: when
       * `accepted*` is behind `current*`, the re-acceptance sheet opens.
       *
       * Both `accepted*` are NULL for an account that predates the columns
       * (deliberately never backfilled — agreeing is a specific act, so a
       * manufactured version would be a lie). The frontend treats NULL as
       * "behind", which is correct: we have no evidence they agreed to
       * anything, so we ask.
       */
      policyVersions: {
        currentTerms: CURRENT_TERMS_VERSION,
        currentGuidelines: CURRENT_GUIDELINES_VERSION,
        acceptedTerms: user.termsVersion,
        acceptedGuidelines: user.guidelinesVersion,
      },
      // { suspendedUntil, suspension } — both null unless the member is suspended.
      ...suspensionInfo,
    };
  }

  /**
   * Finish onboarding: stamp `onboarded_at` and record agreement to the current
   * community guidelines.
   *
   * Behind `ActiveMemberGuard`, which is the one route on this controller that
   * wants it. Stamping those two columns is the member declaring themselves
   * fully joined, and until now nothing here read `status`, so a suspended,
   * banned or deactivated account could complete its own onboarding while under
   * moderation and hand itself the stamps that every "is this member finished?"
   * check downstream reads.
   *
   * The guard does not lock out the legitimate caller, which is the case worth
   * being careful about. Being partway through the wizard is not a status:
   * `UserStatus` has exactly `active`, `suspended` and `deactivated`, every
   * newly created member starts `active` (`UsersService.create` defaults to it),
   * and "not yet onboarded" is a null `onboarded_at` on an otherwise active row.
   * So the guard rejects the three accounts it is aimed at and passes everybody
   * who is genuinely mid-wizard.
   *
   * A 403 rather than a silent no-op: a suspended member reloading the wizard
   * should be told the account is locked, and the client already renders the
   * suspension screen from `GET /auth/me`.
   */
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
  @ApiForbiddenResponse({
    description: 'The account is suspended, banned or deactivated.',
  })
  @UseGuards(ActiveMemberGuard)
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

  /**
   * The member has just told us they are not 18 yet (the onboarding wizard's
   * under-18 branch). Records the disclosure, suspends the account permanently,
   * and revokes every live session — see `UnderAgeDisclosureService` for why
   * each of those three is part of the same act.
   *
   * Authenticated but deliberately NOT behind `ActiveMemberGuard`: a retry
   * arriving after the first call has already suspended the account must still
   * be accepted rather than 403, so the client can be honest about failures
   * instead of silently giving up. Idempotent for the same reason.
   *
   * This device's cookies are cleared on the way out, so the browser is not
   * left holding a session the server has already killed. The frontend signs
   * out immediately afterwards regardless of what this answers. (This used to
   * point at `logout-all` as the reference implementation of that clearing;
   * that route was removed on 2026-08-26, and this is now the only route that
   * clears cookies alongside a full session revoke.)
   *
   * Throttled: it is a self-declared, one-time act, so a burst is never
   * legitimate traffic.
   */
  @ApiOperation({
    summary: 'Record a self-declared under-18 disclosure and lock the account.',
  })
  @ApiCookieAuth('access_token')
  @ApiCreatedResponse({
    description:
      'Disclosure recorded; the account is suspended and signed out.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts.' })
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('under-18-disclosure')
  async underEighteenDisclosure(
    @CurrentUser() current: CurrentUserData,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnderAgeDisclosureResult> {
    const result = await this.underAgeDisclosure.record(current.userId);
    clearAuthCookies(res, this.cookieOpts());
    clearCsrfCookie(res);
    return result;
  }
}
