import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { ReauthResult } from '../../account/account-response';
import { LockdownExempt } from '../../common/lockdown-exempt.decorator';
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
import { EmailCodeEnabledGuard } from './email-code-enabled.guard';
import { EmailCodeRefusedError } from './email-code-refusal';
import {
  EmailCodeRequestAddressThrottlerGuard,
  EmailCodeRequestIpThrottlerGuard,
  EmailCodeVerifyIpThrottlerGuard,
} from './email-code-throttler.guards';
import { EmailCodeLocale } from './email-code.mailer';
import { EmailCodeService, IssuedEmailCode } from './email-code.service';
import { EmailSignInChallengePurpose } from './email-sign-in-challenge.entity';

/** A requester cookie this controller minted: 32 random bytes as base64url. */
const WELL_FORMED_REQUESTER = /^[A-Za-z0-9_-]{43}$/;

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
 * requested the code.
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
 */
@ApiTags('auth')
@LockdownExempt()
@UseGuards(EmailCodeEnabledGuard)
@Controller({ path: 'auth/email-code' })
export class EmailCodeController {
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
    const presented = cookieValue(req, EMAIL_CODE_REQUESTER_COOKIE);
    const requesterKey =
      presented && WELL_FORMED_REQUESTER.test(presented)
        ? presented
        : randomBytes(32).toString('base64url');
    // Set before the service runs, so a refused request still leaves the
    // cookie in place for the retry.
    setEmailCodeRequesterCookie(
      res,
      requesterKey,
      sessionCookieOptsFromConfig(this.config),
    );
    const issued = await this.emailCodes.issueSignInChallenge({
      rawEmail: body.email,
      requesterKey,
      locale: toLocale(body.locale),
      isRegistration: body.isRegistration === true,
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
