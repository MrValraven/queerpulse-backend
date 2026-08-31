import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { CsrfGuard, isSameSite } from './csrf.guard';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator';

const ALLOWED_ORIGIN = 'https://app.queerpulse.test';
// A sibling host under the same registrable domain, which is the deployment the
// `SameSite=Lax` session cookies already require. Used by the `Sec-Fetch-Site`
// cases below, where it makes the guard derive a same-site deployment.
const SAME_SITE_API_ORIGIN = 'https://api.queerpulse.test';
// Somewhere else entirely, for the case where the derivation must switch the
// `Sec-Fetch-Site` check back off.
const CROSS_SITE_API_ORIGIN = 'https://api.somewhere-else.test';

/**
 * A ConfigService stub for the three keys the guard reads: `app.nodeEnv` (which
 * cookie name to expect), `app.frontendOrigins` (the Origin allowlist) and
 * `app.apiUrl` (this API's own origin, which the allowlist is compared against
 * to decide whether `Sec-Fetch-Site` can be enforced).
 */
function configFor(
  nodeEnv: string,
  origins: string[] = [ALLOWED_ORIGIN],
  apiUrl?: string,
): { get: jest.Mock } {
  return {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'app.nodeEnv') return nodeEnv;
      if (key === 'app.frontendOrigins') return origins;
      if (key === 'app.apiUrl') return apiUrl ?? fallback;
      return fallback;
    }),
  };
}

/**
 * A guard whose configuration makes the deployment same-site, so the
 * `Sec-Fetch-Site` check is live. Production is used because outside it the
 * allowlist gains the Vite dev origin, which sits on another site and would
 * (correctly) switch the check back off.
 */
function sameSiteGuard(reflector: Reflector): CsrfGuard {
  return new CsrfGuard(
    reflector,
    configFor(
      'production',
      [ALLOWED_ORIGIN],
      SAME_SITE_API_ORIGIN,
    ) as unknown as ConfigService,
  );
}

/** A matching production token pair, so only the header under test decides. */
function matchingProdTokens(secFetchSite?: string): {
  cookies: Record<string, string>;
  headers: Record<string, string>;
} {
  return {
    cookies: { '__Host-csrf_token': 'match' },
    headers: {
      'x-csrf-token': 'match',
      ...(secFetchSite ? { 'sec-fetch-site': secFetchSite } : {}),
    },
  };
}

function httpContext(
  method: string,
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => ({ method, cookies, headers }) }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: CsrfGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    // Default to non-production, so the guard reads the bare `csrf_token` name
    // the existing cases below use.
    guard = new CsrfGuard(
      reflector as unknown as Reflector,
      configFor('development') as unknown as ConfigService,
    );
  });

  it('allows safe methods without tokens', () => {
    expect(guard.canActivate(httpContext('GET'))).toBe(true);
  });

  it('allows non-http contexts (websocket handshakes)', () => {
    const ctx = {
      getType: () => 'ws',
    } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects mutating requests without tokens', () => {
    expect(() => guard.canActivate(httpContext('POST'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects mismatched cookie and header tokens', () => {
    expect(() =>
      guard.canActivate(
        httpContext('POST', { csrf_token: 'aaa' }, { 'x-csrf-token': 'bbb' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows matching cookie and header tokens', () => {
    expect(
      guard.canActivate(
        httpContext(
          'POST',
          { csrf_token: 'match' },
          { 'x-csrf-token': 'match' },
        ),
      ),
    ).toBe(true);
  });

  it('reads the `__Host-`-prefixed cookie in production', () => {
    const prodGuard = new CsrfGuard(
      reflector as unknown as Reflector,
      configFor('production') as unknown as ConfigService,
    );
    // The bare-named cookie must NOT satisfy the check in production — accepting
    // it would reopen the subdomain fixation vector the prefix closes.
    expect(() =>
      prodGuard.canActivate(
        httpContext('POST', { csrf_token: 'x' }, { 'x-csrf-token': 'x' }),
      ),
    ).toThrow(ForbiddenException);
    // The `__Host-` cookie matching the header passes.
    expect(
      prodGuard.canActivate(
        httpContext(
          'POST',
          { '__Host-csrf_token': 'x' },
          { 'x-csrf-token': 'x' },
        ),
      ),
    ).toBe(true);
  });

  it('allows a matching pair carrying an allowlisted Origin', () => {
    expect(
      guard.canActivate(
        httpContext(
          'POST',
          { csrf_token: 'match' },
          { 'x-csrf-token': 'match', origin: ALLOWED_ORIGIN },
        ),
      ),
    ).toBe(true);
  });

  it('rejects an off-allowlist Origin even when the tokens match', () => {
    expect(() =>
      guard.canActivate(
        httpContext(
          'POST',
          { csrf_token: 'match' },
          { 'x-csrf-token': 'match', origin: 'https://evil.example' },
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  describe('Sec-Fetch-Site', () => {
    it('rejects a cross-site label when the deployment is derived same-site', () => {
      const guardOnOneSite = sameSiteGuard(reflector as unknown as Reflector);
      const { cookies, headers } = matchingProdTokens('cross-site');
      expect(() =>
        guardOnOneSite.canActivate(httpContext('POST', cookies, headers)),
      ).toThrow(ForbiddenException);
    });

    it('allows a cross-site label when the app and API are on different sites', () => {
      // Here every legitimate mutation the browser makes is labelled
      // cross-site, so acting on the label would reject real members.
      const guardAcrossSites = new CsrfGuard(
        reflector as unknown as Reflector,
        configFor(
          'production',
          [ALLOWED_ORIGIN],
          CROSS_SITE_API_ORIGIN,
        ) as unknown as ConfigService,
      );
      const { cookies, headers } = matchingProdTokens('cross-site');
      expect(
        guardAcrossSites.canActivate(httpContext('POST', cookies, headers)),
      ).toBe(true);
    });

    it('allows a cross-site label when any one allowlisted origin is off-site', () => {
      // The verdict is all-or-nothing: one entry on another site means some
      // legitimate traffic carries the cross-site label.
      const guardWithMixedAllowlist = new CsrfGuard(
        reflector as unknown as Reflector,
        configFor(
          'production',
          [ALLOWED_ORIGIN, 'https://partner.elsewhere.test'],
          SAME_SITE_API_ORIGIN,
        ) as unknown as ConfigService,
      );
      const { cookies, headers } = matchingProdTokens('cross-site');
      expect(
        guardWithMixedAllowlist.canActivate(
          httpContext('POST', cookies, headers),
        ),
      ).toBe(true);
    });

    it.each([
      ['absent', undefined],
      ['none', 'none'],
      ['same-origin', 'same-origin'],
      ['same-site', 'same-site'],
      ['an unrecognised value', 'future-label'],
    ])('allows %s even on a same-site deployment', (_label, value) => {
      const guardOnOneSite = sameSiteGuard(reflector as unknown as Reflector);
      const { cookies, headers } = matchingProdTokens(value);
      expect(
        guardOnOneSite.canActivate(httpContext('POST', cookies, headers)),
      ).toBe(true);
    });

    it('still rejects a mismatched token pair carrying a friendly label', () => {
      // The label is a third factor stacked on the other two; it never excuses
      // a failed double-submit compare.
      const guardOnOneSite = sameSiteGuard(reflector as unknown as Reflector);
      expect(() =>
        guardOnOneSite.canActivate(
          httpContext(
            'POST',
            { '__Host-csrf_token': 'aaa' },
            { 'x-csrf-token': 'bbb', 'sec-fetch-site': 'same-origin' },
          ),
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('isSameSite', () => {
    it('treats a shared parent domain as one site regardless of port', () => {
      expect(
        isSameSite('https://app.queerpulse.test', SAME_SITE_API_ORIGIN),
      ).toBe(true);
      expect(isSameSite('http://localhost:5173', 'http://localhost:3000')).toBe(
        true,
      );
    });

    it('treats a differing scheme as cross-site, matching the schemeful rule', () => {
      expect(
        isSameSite('http://app.queerpulse.test', SAME_SITE_API_ORIGIN),
      ).toBe(false);
    });

    it('treats different registrable domains and unparseable values as cross-site', () => {
      expect(isSameSite(ALLOWED_ORIGIN, CROSS_SITE_API_ORIGIN)).toBe(false);
      expect(isSameSite(ALLOWED_ORIGIN, 'not-an-origin')).toBe(false);
    });

    it('matches a bare host or an IP literal against itself alone', () => {
      // `localhost` and `127.0.0.1` have no parent domain to share, so nothing
      // else can be judged same-site with them.
      expect(isSameSite('http://localhost', 'http://localhost:3000')).toBe(
        true,
      );
      expect(isSameSite('http://127.0.0.1:5173', 'http://127.0.0.2:3000')).toBe(
        false,
      );
    });
  });

  it('allows token-less mutating requests on @SkipCsrf routes', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const ctx = httpContext('POST');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(SKIP_CSRF_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
  });
});
