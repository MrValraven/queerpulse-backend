import { validate } from './env.validation';

describe('env validate()', () => {
  const base = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  };

  it('accepts valid env and coerces PORT to a number', () => {
    const result = validate(base);
    expect(result.PORT).toBe(3000);
    expect(typeof result.PORT).toBe('number');
    expect(result.NODE_ENV).toBe('development');
  });

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL, ...rest } = base;
    expect(() => validate(rest)).toThrow();
  });

  it('throws when NODE_ENV is not a known value', () => {
    expect(() => validate({ ...base, NODE_ENV: 'staging' })).toThrow();
  });

  it('allows unknown extra keys (future phases add JWT_*/GOOGLE_* etc.)', () => {
    expect(() => validate({ ...base, JWT_ACCESS_SECRET: 'x' })).not.toThrow();
  });
});
