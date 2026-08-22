import { registerAs } from '@nestjs/config';
import { parseDurationMs } from './duration';

// The shipped defaults, in both forms. Kept adjacent so the string a JWT is
// signed with and the number a cookie expires by can never disagree.
const DEFAULT_ACCESS_TTL = '15m';
const DEFAULT_REFRESH_TTL = '30d';
const DEFAULT_ACCESS_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export default registerAs('auth', () => {
  const jwtAccessTtl = process.env.JWT_ACCESS_TTL ?? DEFAULT_ACCESS_TTL;
  const jwtRefreshTtl = process.env.JWT_REFRESH_TTL ?? DEFAULT_REFRESH_TTL;

  return {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
    jwtAccessTtl,
    jwtRefreshTtl,
    // ONE source of truth for "how long is a session". Everything that needs
    // the TTL as a number derives it from here rather than re-declaring the
    // same duration: the auth cookie `maxAge`s (auth-cookies.ts) and the
    // refresh-row retention sweep (auth-maintenance.service.ts). Before this,
    // `JWT_REFRESH_TTL=7d` left a cookie the browser kept for 30 days holding a
    // JWT that 401s after 7, and `90d` had the browser drop a cookie the server
    // still considered live.
    //
    // `env.validation.ts` rejects an unparseable TTL at boot, so the fallbacks
    // below only ever fire in a unit test that constructs the factory directly.
    jwtAccessTtlMs: parseDurationMs(jwtAccessTtl) ?? DEFAULT_ACCESS_TTL_MS,
    jwtRefreshTtlMs: parseDurationMs(jwtRefreshTtl) ?? DEFAULT_REFRESH_TTL_MS,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL,
    cookieDomain: process.env.COOKIE_DOMAIN,
  };
});
