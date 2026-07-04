import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { setAuthCookies, clearAuthCookies } from './auth-cookies';
import { AuthService, GoogleUserInput } from './auth.service';
import {
  CurrentUser,
  CurrentUserData,
} from './decorators/current-user.decorator';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { Public } from './decorators/public.decorator';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { decodeOAuthState } from './oauth-state';
import { resolvePostLoginRedirect } from './safe-redirect';
import { Throttle, seconds } from '@nestjs/throttler';

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

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth(): void {
    // GoogleAuthGuard redirects to Google's consent screen; this body never runs.
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const profile = req.user as GoogleUserInput;
    const { invite, redirect } = decodeOAuthState(
      typeof req.query.state === 'string' ? req.query.state : undefined,
    );

    let user: User;
    try {
      user = await this.authService.validateOrCreateGoogleUser(profile, invite);
    } catch (err) {
      if (err instanceof SignupRejectedError) {
        const target = new URL(
          '/login',
          this.config.getOrThrow<string>('app.frontendUrl'),
        );
        target.searchParams.set('error', err.reason);
        res.redirect(target.toString());
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

  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const raw = req.cookies?.['refresh_token'];
    if (raw) {
      await this.authService.revokeRefreshToken(raw);
    }
    clearAuthCookies(res, this.cookieOpts());
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
      email: user.email,
      status: user.status,
      role: user.role,
      profile: user.profile ?? null,
    };
  }
}
