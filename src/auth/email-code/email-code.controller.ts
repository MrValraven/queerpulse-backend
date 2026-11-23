import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  SetMetadata,
  UseGuards,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { ReauthResult } from '../../account/account-response';
import {
  LOCKDOWN_EXEMPT_KEY,
  LockdownExempt,
} from '../../common/lockdown-exempt.decorator';
import { SubmittedJoinRequestView } from '../../membership/join-request-response';
import { JoinRequestsService } from '../../membership/join-requests.service';
import { User } from '../../users/entities/user.entity';
import {
  EMAIL_CODE_REQUESTER_COOKIE,
  sessionCookieOptsFromConfig,
  setAuthCookies,
  setEmailCodeRequesterCookie,
} from '../auth-cookies';
import { AuthService } from '../auth.service';
import {
  CurrentUser,
  CurrentUserData,
} from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { SignupRejectedError } from '../errors/signup-rejected.error';
import { resolvePostLoginRedirect } from '../safe-redirect';
import {
  ReauthEmailCodeRequestDto,
  ReauthEmailCodeVerifyDto,
  RequestEmailCodeDto,
  VerifyEmailCodeDto,
} from './dto/email-code.dto';
import {
  RequestJoinRequestEmailCodeDto,
  VerifyJoinRequestEmailCodeDto,
} from './dto/join-request-email-code.dto';
import { EmailCodeEnabledGuard } from './email-code-enabled.guard';
import { EmailCodeRefusedError } from './email-code-refusal';
import {
  EmailCodeJoinRequestDailyAddressThrottlerGuard,
  EmailCodeRequestAddressThrottlerGuard,
  EmailCodeRequestIpThrottlerGuard,
  EmailCodeVerifyIpThrottlerGuard,
} from './email-code-throttler.guards';
import {
  EMAIL_CODE_TRUSTED_REQUESTER_COOKIE,
  setTrustedRequesterCookie,
} from './email-code-trusted-requester';
import { EmailCodeLocale } from './email-code.mailer';
import { EmailCodeService, IssuedEmailCode } from './email-code.service';
import { EmailSignInChallengePurpose } from './email-sign-in-challenge.entity';

/** A requester cookie this controller minted: 32 random bytes as base64url. */
const WELL_FORMED_REQUESTER = /^[A-Za-z0-9_-]{43}$/;

/**
 * Takes a route back out of the class-level `@LockdownExempt()`. Signing in
 * must work during a lockdown; asking to join is ordinary traffic and stays
 * closed with the rest of the platform, as `POST /join-requests` did.
 */
const NotLockdownExempt = () => SetMetadata(LOCKDOWN_EXEMPT_KEY, false);

interface IssuedEmailCodeBody {
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
}

function toLocale(locale: string | undefined): EmailCodeLocale {
  return locale === 'pt' ? 'pt' : 'en';
}

function issuedBody(issued: IssuedEmailCode): IssuedEmailCodeBody {
  return {
    challengeId: issued.challengeId,
    expiresAt: issued.expiresAt.toISOString(),
    resendAvailableAt: issued.resendAvailableAt.toISOString(),
  };
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[name];
}

/**
 * Sign in, and step up before a sensitive action, with a 6-digit code sent to
 * the member's email.
 *
 * Every route is `VERSION_NEUTRAL` and answers at `/auth/email-code/...`: the
 * `refresh_token` cookie and the `email_code_requester` cookie are both scoped
 * to `/auth` (see `auth-cookies.ts`), so a versioned `/v1/auth/...` path would
 * never receive them. Verify needs the refresh token to end the browser's old
 * session and the requester cookie to prove the browser asking is the one that
 * requested the code. The `email_code_trusted` cookie (SEC-11, see
 * `email-code-trusted-requester.ts`) is scoped to `/auth/email-code`.
 *
 * `@LockdownExempt()` for the same reason as `AuthController`: signing in has
 * to keep working while the platform is locked down, or nobody could get back
 * in to lift the lockdown.
 *
 * A correct code is spent only when the session (or the reauth token) is
 * issued. A person refused by a signup gate (a missing name, invite or age
 * attestation) can fix that field and verify again with the same code until it
 * expires.
 *
 * `EmailCodeEnabledGuard` sits on the class, so while the feature is switched
 * off every route answers 503 `email_code_unavailable` before its throttler
 * guards, the body validation or any cookie.
 *
 * The two `join-request` routes file a public invite request (SEC-10): the
 * applicant asks for a code, then sends the form with the code, and the
 * request is filed under the address the code went to. They live here, under
 * `/auth`, for the requester cookie, which only reaches this path.
 */
@ApiTags('auth')
@LockdownExempt()
@UseGuards(EmailCodeEnabledGuard)
@Controller({ path: 'auth/email-code' })
export class EmailCodeController {
  private readonly logger = new Logger(EmailCodeController.name);

  constructor(
    private readonly emailCodes: EmailCodeService,
    private readonly authService: AuthService,
    // Lets an `invite_required` refusal hand an applicant back the status URL
    // of their own join request, the same way `AuthController.googleCallback` does.
    private readonly joinRequestsService: JoinRequestsService,
    private readonly config: ConfigService,
  ) {}

  @ApiOperation({ summary: 'Email a 6-digit sign-in code.' })
  @ApiOkResponse({ description: 'Code issued; the requester cookie is set.' })
  @Version(VERSION_NEUTRAL)
  @Public()
  @UseGuards(
    EmailCodeRequestIpThrottlerGuard,
    EmailCodeRequestAddressThrottlerGuard,
  )
  @HttpCode(200)
  @Post('request')
  async request(
    @Body() body: RequestEmailCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IssuedEmailCodeBody> {
    const requesterKey = this.requesterKeyFor(req, res);
    const issued = await this.emailCodes.issueSignInChallenge({
      rawEmail: body.email,
      requesterKey,
      locale: toLocale(body.locale),
      isRegistration: body.isRegistration === true,
      trustedRequesterToken: cookieValue(
        req,
        EMAIL_CODE_TRUSTED_REQUESTER_COOKIE,
      ),
    });
    return issuedBody(issued);
  }

  @ApiOperation({ summary: 'Check a sign-in code and start a session.' })
  @ApiOkResponse({ description: 'Signed in; auth cookies set.' })
  @Version(VERSION_NEUTRAL)
  @Public()
  @UseGuards(EmailCodeVerifyIpThrottlerGuard)
  @HttpCode(200)
  @Post('verify')
  async verify(
    @Body() body: VerifyEmailCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ redirectTo: string }> {
    const verified = await this.emailCodes.verifyChallenge({
      challengeId: body.challengeId,
      code: body.code,
      purpose: EmailSignInChallengePurpose.SignIn,
      requesterKey: cookieValue(req, EMAIL_CODE_REQUESTER_COOKIE) ?? '',
    });
    const frontendUrl = this.config.getOrThrow<string>('app.frontendUrl');

    // Every refusal below leaves the challenge open, so the same code works
    // again once the person fixes the field the gate asked for.
    let user: User;
    try {
      user = await this.authService.signInWithVerifiedEmail(verified.email, {
        inviteCode: body.invite,
        ageAttested: body.ageAttested,
        termsVersion: body.termsVersion,
        firstName: body.firstName,
        lastName: body.lastName,
      });
    } catch (err) {
      if (err instanceof SignupRejectedError) {
        throw await this.signupRefusal(err, verified.email, frontendUrl);
      }
      throw err;
    }

    // A concurrent verify may have spent the code between the check and here.
    if (!(await this.emailCodes.consumeChallenge(body.challengeId))) {
      throw new EmailCodeRefusedError('code_already_used');
    }

    // End the session this browser already held before starting a new one,
    // as `AuthController.googleCallback` does.
    await this.authService.revokeSessionForToken(
      cookieValue(req, 'refresh_token'),
    );
    const tokens = await this.authService.issueTokens(
      user,
      req.headers['user-agent'],
    );
    setAuthCookies(res, tokens, sessionCookieOptsFromConfig(this.config));
    this.trustThisBrowser(res, verified.email);
    return { redirectTo: resolvePostLoginRedirect(body.redirect, frontendUrl) };
  }

  @ApiOperation({ summary: "Email a step-up code to the caller's address." })
  @ApiOkResponse({ description: 'Code issued to the account email.' })
  @Version(VERSION_NEUTRAL)
  @UseGuards(EmailCodeRequestIpThrottlerGuard)
  @HttpCode(200)
  @Post('reauth/request')
  async reauthRequest(
    @CurrentUser() current: CurrentUserData,
    @Body() body: ReauthEmailCodeRequestDto,
  ): Promise<IssuedEmailCodeBody & { email: string }> {
    // `JwtStrategy` re-reads the email from the users row on every request.
    const issued = await this.emailCodes.issueReauthChallenge({
      userId: current.userId,
      email: current.email,
      locale: toLocale(body.locale),
    });
    return { ...issuedBody(issued), email: current.email };
  }

  @ApiOperation({ summary: 'Check a step-up code and mint a reauth token.' })
  @ApiOkResponse({ description: 'Reauth token minted.' })
  @Version(VERSION_NEUTRAL)
  @UseGuards(EmailCodeVerifyIpThrottlerGuard)
  @HttpCode(200)
  @Post('reauth/verify')
  async reauthVerify(
    @CurrentUser() current: CurrentUserData,
    @Body() body: ReauthEmailCodeVerifyDto,
  ): Promise<ReauthResult> {
    await this.emailCodes.verifyChallenge({
      challengeId: body.challengeId,
      code: body.code,
      purpose: EmailSignInChallengePurpose.Reauth,
      requesterKey: `user:${current.userId}`,
      userId: current.userId,
    });
    if (!(await this.emailCodes.consumeChallenge(body.challengeId))) {
      throw new EmailCodeRefusedError('code_already_used');
    }
    return this.authService.mintReauthToken(current.userId);
  }

  @ApiOperation({
    summary: 'Email a 6-digit code that confirms a join-request address.',
  })
  @ApiOkResponse({
    description:
      'Code issued; the requester cookie is set. Every address gets this same answer.',
  })
  @Version(VERSION_NEUTRAL)
  @Public()
  @NotLockdownExempt()
  @UseGuards(
    EmailCodeRequestIpThrottlerGuard,
    EmailCodeRequestAddressThrottlerGuard,
    EmailCodeJoinRequestDailyAddressThrottlerGuard,
  )
  @HttpCode(200)
  @Post('join-request/request')
  async joinRequestCodeRequest(
    @Body() body: RequestJoinRequestEmailCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IssuedEmailCodeBody> {
    // The kill switch reads no address, so it may answer before any code goes out.
    await this.joinRequestsService.assertAcceptingRequests();
    const requesterKey = this.requesterKeyFor(req, res);
    const issued = await this.emailCodes.issueJoinRequestChallenge({
      rawEmail: body.email,
      requesterKey,
      locale: toLocale(body.locale),
      trustedRequesterToken: cookieValue(
        req,
        EMAIL_CODE_TRUSTED_REQUESTER_COOKIE,
      ),
    });
    return issuedBody(issued);
  }

  /**
   * Files the join request once the code proves the applicant holds the
   * address (SEC-10). Before the code is checked, only the answers that read
   * no address can come back: the kill switch (403 `JOIN_REQUESTS_CLOSED`),
   * the date of birth (403 `UNDER_18`) and the code refusals, which read the
   * same for every address. The cooldown 403 and the pending 409 come after,
   * so they reach only the person holding the inbox.
   *
   * Throttled 10/hour per IP by the global throttler (anonymous traffic is
   * keyed by client IP). The per-address code send cap is what limits spam
   * aimed at one address, so this only bounds one network's filing rate.
   * Spending the code after the row is saved is safe: a concurrent second
   * filing with the same code meets the pending-email unique index and gets
   * the 409.
   */
  @ApiOperation({ summary: 'Check a join-request code and file the request.' })
  @ApiCreatedResponse({
    description:
      'The invite request was recorded; the body carries the status token once.',
  })
  @Version(VERSION_NEUTRAL)
  @Public()
  @NotLockdownExempt()
  @Throttle({ default: { limit: 10, ttl: seconds(3600) } })
  @UseGuards(EmailCodeVerifyIpThrottlerGuard)
  @HttpCode(201)
  @Post('join-request/verify')
  async joinRequestCodeVerify(
    @Body() body: VerifyJoinRequestEmailCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmittedJoinRequestView> {
    const { challengeId, code, ...form } = body;
    await this.joinRequestsService.assertSubmittable(form);
    const verified = await this.emailCodes.verifyChallenge({
      challengeId,
      code,
      purpose: EmailSignInChallengePurpose.JoinRequest,
      requesterKey: cookieValue(req, EMAIL_CODE_REQUESTER_COOKIE) ?? '',
    });
    const submitted = await this.joinRequestsService.submit({
      ...form,
      email: verified.email,
    });
    this.trustThisBrowser(res, verified.email);
    // The request is filed, and the 201 carries its only status token, so a
    // failed spend is logged and the applicant still gets their answer. The
    // open code expires with its TTL, and the pending-email unique index
    // answers any second filing with it with the 409.
    try {
      await this.emailCodes.consumeChallenge(challengeId);
    } catch (error) {
      this.logger.warn(
        `Join-request code spend failed after filing: name=${error instanceof Error ? error.name : typeof error} challengeId=${challengeId} joinRequestId=${submitted.id}`,
      );
    }
    return submitted;
  }

  /**
   * The browser's requester key: the cookie it already holds when this
   * controller minted it, else a fresh one. Set before the service runs, so a
   * refused request still leaves the cookie in place for the retry.
   */
  private requesterKeyFor(req: Request, res: Response): string {
    const presented = cookieValue(req, EMAIL_CODE_REQUESTER_COOKIE);
    const requesterKey =
      presented && WELL_FORMED_REQUESTER.test(presented)
        ? presented
        : randomBytes(32).toString('base64url');
    setEmailCodeRequesterCookie(
      res,
      requesterKey,
      sessionCookieOptsFromConfig(this.config),
    );
    return requesterKey;
  }

  /**
   * Marks this browser as a trusted requester for the address it just proved
   * it holds (SEC-11): its later code requests for that address draw on the
   * reserved allowance. Renewed on every successful verify. The cookie holds
   * an expiry and an HMAC; the address stays out of it.
   */
  private trustThisBrowser(res: Response, email: string): void {
    setTrustedRequesterCookie(
      res,
      this.emailCodes.mintTrustedRequesterToken(email),
      sessionCookieOptsFromConfig(this.config),
    );
  }

  /**
   * The refusal for a signup gate. An `invite_required` applicant with a join
   * request on file gets their status URL back; the code they typed has just
   * proved they own the address, which is the proof
   * `recoverStatusTokenForVerifiedEmail` asks for.
   */
  private async signupRefusal(
    err: SignupRejectedError,
    email: string,
    frontendUrl: string,
  ): Promise<EmailCodeRefusedError> {
    let statusUrl: string | undefined;
    if (err.reason === 'invite_required') {
      const statusToken =
        await this.joinRequestsService.recoverStatusTokenForVerifiedEmail(
          email,
        );
      if (statusToken) {
        const target = new URL('/auth/request-invite/status', frontendUrl);
        target.searchParams.set('token', statusToken);
        statusUrl = target.toString();
      }
    }
    return new EmailCodeRefusedError(
      err.reason,
      statusUrl ? { statusUrl } : undefined,
    );
  }
}
