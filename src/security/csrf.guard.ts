import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator';
import { csrfCookieName } from './csrf-cookie';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // HTTP only — WebSocket handshakes are authenticated in the gateway.
    if (context.getType() !== 'http') {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) {
      return true;
    }
    // Routes with their own request authentication (signed webhooks) opt out.
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    // Read ONLY the environment's active cookie name — in production the
    // `__Host-` variant. We deliberately do NOT fall back to the legacy
    // `csrf_token` name: accepting it would reopen the very fixation vector the
    // prefix closes (a subdomain can still write a plain `csrf_token`). Sessions
    // open across a deploy self-heal — the SPA's on-403 CSRF path re-fetches a
    // token, which sets the `__Host-` cookie — so the strict read costs at most
    // one silently-retried request, not a logout.
    const cookieName = csrfCookieName(this.config.get<string>('app.nodeEnv'));
    const cookieToken: unknown = req.cookies?.[cookieName];
    const headerToken = req.headers['x-csrf-token'];
    if (
      typeof cookieToken !== 'string' ||
      typeof headerToken !== 'string' ||
      !this.safeEqual(cookieToken, headerToken)
    ) {
      throw new ForbiddenException('Invalid or missing CSRF token');
    }
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ab, bb);
  }
}
