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
import { DEFAULT_FRONTEND_ORIGIN } from '../config/frontend-origins';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  // Resolved once: the allowlist comes from FRONTEND_URL, which cannot change
  // without a restart.
  private cachedOrigins: Set<string> | null = null;

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
    // Defense in depth, checked BEFORE the token compare so a forged request
    // never gets as far as a timing-observable comparison.
    //
    // Double-submit alone is sound against a cross-site attacker (the custom
    // X-CSRF-Token header forces a preflight the browser will not let them
    // pass), but it is only as strong as the cookie: fixate the cookie and the
    // check is satisfiable. Requiring the `Origin` to be an origin we already
    // serve via CORS adds a second, independent factor.
    //
    // Only checked when the header is PRESENT. Non-browser callers (native
    // clients, supertest, curl) send no `Origin`, and they are not the CSRF
    // threat model, which is by definition a browser on a page the attacker
    // controls. Browsers always attach `Origin` to a state-changing request.
    //
    // `Sec-Fetch-Site: cross-site` is deliberately NOT treated as a reject,
    // despite being the obvious companion signal: the SPA and this API are on
    // different registrable domains, so EVERY legitimate mutation this app
    // makes is labelled cross-site. It would reject all traffic, not attacks.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !this.allowedOrigins().has(origin)) {
      throw new ForbiddenException('Origin not allowed');
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

  /**
   * The same allowlist `main.ts` hands to `enableCors`, including its
   * outside-production addition of the Vite dev origin. Reading it from the
   * same `app.frontendOrigins` config key is what keeps CORS and this check
   * from drifting apart.
   */
  private allowedOrigins(): Set<string> {
    if (!this.cachedOrigins) {
      const configured = this.config.get<string[]>('app.frontendOrigins', [
        DEFAULT_FRONTEND_ORIGIN,
      ]);
      const isProduction =
        this.config.get<string>('app.nodeEnv') === 'production';
      this.cachedOrigins = new Set(
        isProduction ? configured : [...configured, DEFAULT_FRONTEND_ORIGIN],
      );
    }
    return this.cachedOrigins;
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
