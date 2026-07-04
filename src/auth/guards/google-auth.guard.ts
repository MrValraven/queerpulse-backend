import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { encodeOAuthState } from '../oauth-state';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  getAuthenticateOptions(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const invite =
      typeof req.query?.invite === 'string' ? req.query.invite : undefined;
    const redirect =
      typeof req.query?.redirect === 'string' ? req.query.redirect : undefined;
    // Carry both the invite code and the post-login redirect across the Google
    // consent hop via the OAuth `state` param (validated on the way back).
    const state = encodeOAuthState({ invite, redirect });
    return state ? { state } : {};
  }
}
