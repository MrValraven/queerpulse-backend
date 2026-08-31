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

// The only `Sec-Fetch-Site` value that can mean "a page we do not serve started
// this mutation". The other values the fetch-metadata spec defines
// (`same-origin`, `same-site`, `none`) describe our own app or a person acting
// directly on the URL, and an absent header describes a caller that is not a
// browser at all.
const CROSS_SITE_FETCH_LABEL = 'cross-site';

// A dotted-quad host has dots but no domain structure, so it can only ever be
// same-site with itself. Kept at module scope so the regex is compiled once.
const IPV4_HOSTNAME = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Whether two origins are same-site in the sense a browser uses when it fills in
 * `Sec-Fetch-Site`: the same scheme (the label is *schemefully* same-site) and
 * the same registrable domain, with the port ignored.
 *
 * There is no public-suffix list behind this and we are deliberately not adding
 * a dependency for one, so "registrable domain" is approximated as the last two
 * labels of the host. The approximation is wrong in exactly one direction: it
 * calls `foo.co.uk` and `bar.co.uk` same-site where a browser calls them
 * cross-site. That wrong verdict is bounded and self-announcing. It would only
 * arise in a deployment whose app and API sit under two different registrable
 * domains sharing a multi-label public suffix, and such a deployment cannot keep
 * anybody signed in in the first place: the session cookies are `SameSite=Lax`
 * (`auth/auth-cookies.ts`), and a Lax cookie is withheld from a cross-site
 * request entirely. Nobody arrives at a mutation for this check to judge without
 * having first arrived at a working session, so the failure mode is a deployment
 * that is already broken for a more basic reason.
 *
 * A host with fewer than two labels (`localhost`) or a literal IP address has no
 * parent domain to share, so it matches itself alone.
 */
export function isSameSite(originA: string, originB: string): boolean {
  const urlA = parseOrigin(originA);
  const urlB = parseOrigin(originB);
  if (!urlA || !urlB || urlA.protocol !== urlB.protocol) {
    return false;
  }
  const hostnameA = urlA.hostname.toLowerCase();
  const hostnameB = urlB.hostname.toLowerCase();
  if (hostnameA === hostnameB) {
    return true;
  }
  const parentDomainA = parentDomainOf(hostnameA);
  const parentDomainB = parentDomainOf(hostnameB);
  return parentDomainA !== null && parentDomainA === parentDomainB;
}

function parseOrigin(origin: string): URL | null {
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

function parentDomainOf(hostname: string): string | null {
  // `new URL` hands back an IPv6 host wrapped in brackets; both IP forms are
  // handled by the exact-host comparison above and share no parent domain.
  if (hostname.startsWith('[') || IPV4_HOSTNAME.test(hostname)) {
    return null;
  }
  const labels = hostname.split('.');
  if (labels.length < 2) {
    return null;
  }
  return labels.slice(-2).join('.');
}

@Injectable()
export class CsrfGuard implements CanActivate {
  // Resolved once: the allowlist comes from FRONTEND_URL, which cannot change
  // without a restart.
  private cachedOrigins: Set<string> | null = null;
  // Resolved once for the same reason: the site comparison reads FRONTEND_URL
  // and API_URL, both fixed at boot, so every request after the first reads a
  // boolean instead of re-parsing URLs.
  private cachedIsSameSiteDeployment: boolean | null = null;

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
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !this.allowedOrigins().has(origin)) {
      throw new ForbiddenException('Origin not allowed');
    }

    // `Sec-Fetch-Site` is the companion signal, and whether this guard may act
    // on it is DERIVED from configuration rather than asserted in prose:
    // `isSameSiteDeployment()` compares the origins we serve via CORS against
    // this API's own public origin. Where they share a site, every legitimate
    // browser mutation is labelled `same-origin` or `same-site`, so the
    // `cross-site` label can only have come from a page we do not serve, and
    // rejecting it stacks a third independent factor on the double-submit token
    // and the `Origin` allowlist above. Where they do not share a site,
    // legitimate traffic carries that same label, so the signal says nothing and
    // the first two factors carry the request alone.
    //
    // The session already pins down which of those two worlds a deployment is
    // in. The auth cookies are `SameSite=Lax` (`auth/auth-cookies.ts`) and a Lax
    // cookie is withheld from a cross-site request, so an app served from
    // another site could not keep anyone signed in long enough to mutate
    // anything. Deriving the answer rather than writing it down means that the
    // day someone moves the session to `SameSite=None` and splits the two hosts,
    // this guard follows the configuration instead of a comment nobody updated.
    //
    // As with `Origin`, only a PRESENT and recognised value can reject. Native
    // clients, supertest and curl send no `Sec-Fetch-Site`; a bookmark or a
    // typed URL sends `none`. Neither is the browser-on-an-attacker-page threat
    // model, so an absent header, `same-origin`, `same-site`, `none` and any
    // value we do not recognise all pass.
    if (
      req.headers['sec-fetch-site'] === CROSS_SITE_FETCH_LABEL &&
      this.isSameSiteDeployment()
    ) {
      throw new ForbiddenException('Cross-site request rejected');
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

  /**
   * True when every origin this API serves via CORS shares a site with the
   * API's own public origin (`app.apiUrl`, from `API_URL`), which is exactly
   * the condition under which a browser labels our legitimate mutations
   * `same-origin` or `same-site`.
   *
   * The verdict is all-or-nothing across the allowlist on purpose.
   * `FRONTEND_URL` may list apex, www and a staging host, and it gains the Vite
   * dev origin outside production; if even one of those entries sits on another
   * site then some legitimate traffic arrives labelled `cross-site`, and the
   * only safe reading of the signal is to stop reading it. Erring toward "not
   * same-site" costs a defense-in-depth factor. Erring the other way would
   * reject real members.
   */
  private isSameSiteDeployment(): boolean {
    if (this.cachedIsSameSiteDeployment === null) {
      const apiOrigin = this.config.get<string>(
        'app.apiUrl',
        'http://localhost:3000',
      );
      this.cachedIsSameSiteDeployment = Array.from(this.allowedOrigins()).every(
        (frontendOrigin) => isSameSite(frontendOrigin, apiOrigin),
      );
    }
    return this.cachedIsSameSiteDeployment;
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
