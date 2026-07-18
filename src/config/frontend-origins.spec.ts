import {
  DEFAULT_FRONTEND_ORIGIN,
  invalidFrontendOrigins,
  parseFrontendOrigins,
  resolveFrontendOrigins,
} from './frontend-origins';

describe('parseFrontendOrigins', () => {
  it('parses a single origin (the historical, backwards-compatible case)', () => {
    expect(parseFrontendOrigins('https://queerpulse.com')).toEqual([
      'https://queerpulse.com',
    ]);
  });

  it('parses a comma-separated allowlist in order', () => {
    expect(
      parseFrontendOrigins(
        'https://queerpulse.com,https://www.queerpulse.com,https://staging.queerpulse.com',
      ),
    ).toEqual([
      'https://queerpulse.com',
      'https://www.queerpulse.com',
      'https://staging.queerpulse.com',
    ]);
  });

  it('keeps the canonical (first) origin first — redirects depend on the order', () => {
    const [canonical] = parseFrontendOrigins(
      'https://queerpulse.com,https://www.queerpulse.com',
    );
    expect(canonical).toBe('https://queerpulse.com');
  });

  it('trims whitespace around entries', () => {
    expect(
      parseFrontendOrigins(
        ' https://queerpulse.com , https://www.queerpulse.com ',
      ),
    ).toEqual(['https://queerpulse.com', 'https://www.queerpulse.com']);
  });

  it('strips trailing slashes (an Origin header never has one)', () => {
    expect(parseFrontendOrigins('https://queerpulse.com/')).toEqual([
      'https://queerpulse.com',
    ]);
  });

  it('drops empty entries from stray/trailing commas', () => {
    expect(parseFrontendOrigins('https://queerpulse.com,,')).toEqual([
      'https://queerpulse.com',
    ]);
  });

  it('de-duplicates repeated origins, including after normalisation', () => {
    expect(
      parseFrontendOrigins('https://queerpulse.com,https://queerpulse.com/'),
    ).toEqual(['https://queerpulse.com']);
  });

  it('preserves an explicit port', () => {
    expect(parseFrontendOrigins('http://localhost:4173')).toEqual([
      'http://localhost:4173',
    ]);
  });

  it('falls back to the dev origin when unset', () => {
    expect(parseFrontendOrigins(undefined)).toEqual([DEFAULT_FRONTEND_ORIGIN]);
  });

  it('falls back to the dev origin when empty or whitespace-only', () => {
    expect(parseFrontendOrigins('')).toEqual([DEFAULT_FRONTEND_ORIGIN]);
    expect(parseFrontendOrigins('   ')).toEqual([DEFAULT_FRONTEND_ORIGIN]);
    expect(parseFrontendOrigins(',')).toEqual([DEFAULT_FRONTEND_ORIGIN]);
  });

  it('never returns an empty array (an empty CORS allowlist would deny everything)', () => {
    for (const raw of [undefined, '', ' ', ',,,']) {
      expect(parseFrontendOrigins(raw).length).toBeGreaterThan(0);
    }
  });
});

describe('resolveFrontendOrigins', () => {
  const original = process.env.FRONTEND_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = original;
    }
  });

  it('reads process.env at call time, not at module load', () => {
    process.env.FRONTEND_URL =
      'https://queerpulse.com,https://www.queerpulse.com';
    expect(resolveFrontendOrigins()).toEqual([
      'https://queerpulse.com',
      'https://www.queerpulse.com',
    ]);

    // The gateway's CORS callback runs per-handshake; a later value must win.
    process.env.FRONTEND_URL = 'https://other.example';
    expect(resolveFrontendOrigins()).toEqual(['https://other.example']);
  });

  it('falls back to the dev origin when FRONTEND_URL is unset', () => {
    delete process.env.FRONTEND_URL;
    expect(resolveFrontendOrigins()).toEqual([DEFAULT_FRONTEND_ORIGIN]);
  });
});

describe('invalidFrontendOrigins', () => {
  it('accepts exact origins', () => {
    expect(
      invalidFrontendOrigins(
        'https://queerpulse.com,http://localhost:5173,https://www.queerpulse.com',
      ),
    ).toEqual([]);
  });

  it('accepts an entry that only needed its trailing slash normalised away', () => {
    expect(invalidFrontendOrigins('https://queerpulse.com/')).toEqual([]);
  });

  it('rejects a bare hostname with no scheme', () => {
    expect(invalidFrontendOrigins('queerpulse.com')).toEqual([
      'queerpulse.com',
    ]);
  });

  it('rejects an origin carrying a path', () => {
    expect(invalidFrontendOrigins('https://queerpulse.com/app')).toEqual([
      'https://queerpulse.com/app',
    ]);
  });

  it('rejects an origin carrying a query or fragment', () => {
    expect(invalidFrontendOrigins('https://queerpulse.com/?a=1')).toEqual([
      'https://queerpulse.com/?a=1',
    ]);
    expect(invalidFrontendOrigins('https://queerpulse.com/#x')).toEqual([
      'https://queerpulse.com/#x',
    ]);
  });

  it('reports only the offending entries from a mixed list', () => {
    expect(
      invalidFrontendOrigins(
        'https://queerpulse.com,not a url,https://ok.example',
      ),
    ).toEqual(['not a url']);
  });

  it('treats unset/empty as valid (the default origin applies)', () => {
    expect(invalidFrontendOrigins(undefined)).toEqual([]);
    expect(invalidFrontendOrigins('')).toEqual([]);
  });
});
