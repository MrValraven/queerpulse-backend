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
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_REFRESH_SECRET: 'refresh-secret',
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
