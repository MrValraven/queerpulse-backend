// Loaded by @nestjs/core in the app; this spec imports validate() directly,
// so the decorator metadata polyfill must be registered here.
import 'reflect-metadata';
import { validate } from './env.validation';

describe('env validate()', () => {
  // All required vars as of the current EnvironmentVariables class.
  const base = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    // Both must clear @MinLength(32) and differ from each other.
    JWT_ACCESS_SECRET: 'access-secret-at-least-thirty-two-chars',
    JWT_REFRESH_SECRET: 'refresh-secret-at-least-thirty-two-chars',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google/callback',
  };

  it('accepts valid env and coerces PORT to a number', () => {
    const result = validate(base);
    expect(result.PORT).toBe(3000);
    expect(typeof result.PORT).toBe('number');
    expect(result.NODE_ENV).toBe('development');
  });

  it('throws when DATABASE_URL is missing', () => {
    const rest: Record<string, string> = { ...base };
    delete rest.DATABASE_URL;
    expect(() => validate(rest)).toThrow();
  });

  it('throws when NODE_ENV is not a known value', () => {
    expect(() => validate({ ...base, NODE_ENV: 'staging' })).toThrow();
  });

  it('allows unknown extra keys (future phases add new vars)', () => {
    expect(() => validate({ ...base, SOME_FUTURE_VAR: 'x' })).not.toThrow();
  });

  it('accepts env without any MUX_* vars (Mux is optional)', () => {
    expect(() => validate(base)).not.toThrow();
  });

  it('rejects an unparseable JWT TTL by name', () => {
    expect(() => validate({ ...base, JWT_REFRESH_TTL: '1 month' })).toThrow(
      /JWT_REFRESH_TTL/,
    );
    expect(() => validate({ ...base, JWT_ACCESS_TTL: '15m' })).not.toThrow();
  });

  // A wildcard cookie Domain lets any subdomain plant the session cookie.
  // Asserted on the message rather than on throw/not-throw, so this stays
  // meaningful as other production requirements are added to `validate`.
  it('refuses COOKIE_DOMAIN in production unless explicitly acknowledged', () => {
    const errorFor = (env: Record<string, string>): string => {
      try {
        validate(env);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const production = {
      ...base,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://queerpulse.com',
      API_URL: 'https://api.queerpulse.com',
      METRICS_TOKEN: 'metrics-token-sixteen-plus-chars',
      AWS_ENDPOINT_URL: 'https://bucket.example',
      AWS_DEFAULT_REGION: 'auto',
      AWS_S3_BUCKET_NAME: 'bucket',
      AWS_ACCESS_KEY_ID: 'key',
      AWS_SECRET_ACCESS_KEY: 'secret',
      CARD_SIGNING_PRIVATE_KEY: 'card-signing-private-pem',
      CARD_SIGNING_PUBLIC_KEY: 'card-signing-public-pem',
    };

    expect(errorFor(production)).not.toMatch(/COOKIE_DOMAIN/);
    expect(
      errorFor({ ...production, COOKIE_DOMAIN: '.queerpulse.com' }),
    ).toMatch(/COOKIE_DOMAIN/);
    expect(
      errorFor({
        ...production,
        COOKIE_DOMAIN: '.queerpulse.com',
        ALLOW_COOKIE_DOMAIN: 'true',
      }),
    ).not.toMatch(/COOKIE_DOMAIN/);
  });

  // Left unset in production, CardTokenService.mint() throws a raw Error at
  // request time (a 500 on every QR mint) rather than failing at boot.
  it('requires CARD_SIGNING_* keys in production', () => {
    const errorFor = (env: Record<string, string>): string => {
      try {
        validate(env);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const production = {
      ...base,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://queerpulse.com',
      API_URL: 'https://api.queerpulse.com',
      METRICS_TOKEN: 'metrics-token-sixteen-plus-chars',
      AWS_ENDPOINT_URL: 'https://bucket.example',
      AWS_DEFAULT_REGION: 'auto',
      AWS_S3_BUCKET_NAME: 'bucket',
      AWS_ACCESS_KEY_ID: 'key',
      AWS_SECRET_ACCESS_KEY: 'secret',
      CARD_SIGNING_PRIVATE_KEY: 'card-signing-private-pem',
      CARD_SIGNING_PUBLIC_KEY: 'card-signing-public-pem',
    };

    expect(errorFor(production)).toBe('');

    const withoutPrivate: Record<string, string> = { ...production };
    delete withoutPrivate.CARD_SIGNING_PRIVATE_KEY;
    expect(errorFor(withoutPrivate)).toMatch(/CARD_SIGNING_PRIVATE_KEY/);

    const withoutPublic: Record<string, string> = { ...production };
    delete withoutPublic.CARD_SIGNING_PUBLIC_KEY;
    expect(errorFor(withoutPublic)).toMatch(/CARD_SIGNING_PUBLIC_KEY/);
  });

  // MetricsTokenGuard fails CLOSED in production, so an unset METRICS_TOKEN
  // shuts /metrics, /health and /health/ready with a 403 while the ungated
  // /health/live keeps the deploy green. Boot must not refuse over it (that
  // would break a production already running without a token), so the contract
  // asserted here is exactly: survivable, and loud.
  it('warns without refusing to boot when production has no METRICS_TOKEN', () => {
    const production: Record<string, string> = {
      ...base,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://queerpulse.com',
      API_URL: 'https://api.queerpulse.com',
      AWS_ENDPOINT_URL: 'https://bucket.example',
      AWS_DEFAULT_REGION: 'auto',
      AWS_S3_BUCKET_NAME: 'bucket',
      AWS_ACCESS_KEY_ID: 'key',
      AWS_SECRET_ACCESS_KEY: 'secret',
      CARD_SIGNING_PRIVATE_KEY: 'card-signing-private-pem',
      CARD_SIGNING_PUBLIC_KEY: 'card-signing-public-pem',
    };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => validate(production)).not.toThrow();

      const warningText = warnSpy.mock.calls.map(String).join('\n');
      expect(warningText).toMatch(/METRICS_TOKEN/);
      // The consequence has to be named, route by route, or the warning is just
      // as easy to skip as the silence it replaced.
      expect(warningText).toMatch(/\/metrics/);
      expect(warningText).toMatch(/\/health\/ready/);
      expect(warningText).toMatch(/403/);

      warnSpy.mockClear();
      expect(() =>
        validate({
          ...production,
          METRICS_TOKEN: 'metrics-token-sixteen-plus-chars',
        }),
      ).not.toThrow();
      expect(warnSpy.mock.calls.map(String).join('\n')).not.toMatch(
        /METRICS_TOKEN/,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('accepts all five MUX_* vars as strings', () => {
    expect(() =>
      validate({
        ...base,
        MUX_TOKEN_ID: 'token-id',
        MUX_TOKEN_SECRET: 'token-secret',
        MUX_WEBHOOK_SECRET: 'webhook-secret',
        MUX_SIGNING_KEY_ID: 'signing-key-id',
        MUX_SIGNING_PRIVATE_KEY: 'base64-pem',
      }),
    ).not.toThrow();
  });
});
