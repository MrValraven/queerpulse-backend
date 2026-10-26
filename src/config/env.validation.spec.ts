// Loaded by @nestjs/core in the app; this spec imports validate() directly,
// so the decorator metadata polyfill must be registered here.
import 'reflect-metadata';
import { DEV_SETUP_HINT, validate } from './env.validation';

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
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'QueerPulse <hello@queerpulse.com>',
      RESEND_SIGNIN_TEMPLATE_ID_EN: 'template-en',
      RESEND_SIGNIN_TEMPLATE_ID_PT: 'template-pt',
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
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'QueerPulse <hello@queerpulse.com>',
      RESEND_SIGNIN_TEMPLATE_ID_EN: 'template-en',
      RESEND_SIGNIN_TEMPLATE_ID_PT: 'template-pt',
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

  it('accepts a positive creator draft retention window', () => {
    expect(
      validate({ ...base, CREATOR_DRAFT_RETENTION_DAYS: '30' })
        .CREATOR_DRAFT_RETENTION_DAYS,
    ).toBe(30);
  });

  it.each(['0', '-5', '1.5', 'ninety'])(
    'refuses CREATOR_DRAFT_RETENTION_DAYS=%s',
    (value) => {
      expect(() =>
        validate({ ...base, CREATOR_DRAFT_RETENTION_DAYS: value }),
      ).toThrow();
    },
  );

  // Without the RESEND_* values the email-code sign-in is simply switched off
  // (see email.config.ts), so production boots and hides the feature.
  it('boots in production without any Resend variable', () => {
    const production: Record<string, string> = {
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

    expect(() => validate(production)).not.toThrow();
    expect(() =>
      validate({ ...production, EMAIL_CODE_DEV_LOG: 'true' }),
    ).not.toThrow();
  });

  it('boots in development without any Resend variable', () => {
    expect(() => validate(base)).not.toThrow();
  });

  it('accepts EMAIL_CODE_DEV_LOG as an optional string', () => {
    expect(() =>
      validate({ ...base, EMAIL_CODE_DEV_LOG: 'true' }),
    ).not.toThrow();
    expect(() =>
      validate({ ...base, EMAIL_CODE_DEV_LOG: 'false' }),
    ).not.toThrow();
  });

  it('rejects an EMAIL_CODE_SECRET shorter than 32 characters', () => {
    expect(() => validate({ ...base, EMAIL_CODE_SECRET: 'too-short' })).toThrow(
      /EMAIL_CODE_SECRET/,
    );
  });

  it('accepts production without EMAIL_CODE_SECRET (derived from JWT_ACCESS_SECRET)', () => {
    const production: Record<string, string> = {
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
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'QueerPulse <hello@queerpulse.com>',
      RESEND_SIGNIN_TEMPLATE_ID_EN: 'template-en',
      RESEND_SIGNIN_TEMPLATE_ID_PT: 'template-pt',
    };
    expect(() => validate(production)).not.toThrow();
  });

  describe('local development helpers', () => {
    const errorFor = (env: Record<string, string>): string => {
      try {
        validate(env);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const production: Record<string, string> = {
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

    it('accepts AWS_PUBLIC_ENDPOINT_URL in development', () => {
      expect(() =>
        validate({ ...base, AWS_PUBLIC_ENDPOINT_URL: 'http://localhost:9000' }),
      ).not.toThrow();
    });

    it('refuses AWS_PUBLIC_ENDPOINT_URL in production, naming it', () => {
      expect(errorFor(production)).toBe('');
      expect(
        errorFor({
          ...production,
          AWS_PUBLIC_ENDPOINT_URL: 'http://localhost:9000',
        }),
      ).toMatch(/AWS_PUBLIC_ENDPOINT_URL is for the local MinIO bucket only/);
    });

    it('ends a development failure with the dev:setup hint', () => {
      const message = errorFor({ ...base, JWT_REFRESH_TTL: '1 month' });
      expect(message).toMatch(/JWT_REFRESH_TTL/);
      expect(message.split('\n').at(-1)).toBe(DEV_SETUP_HINT);

      const rest: Record<string, string> = { ...base };
      delete rest.DATABASE_URL;
      expect(errorFor(rest).split('\n').at(-1)).toBe(DEV_SETUP_HINT);
    });

    it('leaves the production failure message without the hint', () => {
      const message = errorFor({ ...production, JWT_REFRESH_TTL: '1 month' });
      expect(message).toMatch(/JWT_REFRESH_TTL/);
      expect(message).not.toContain('dev:setup');
    });
  });
});
