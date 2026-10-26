import {
  dropLandingVisitRequest,
  isLandingVisitBeacon,
} from './landing-visit-request-log';

describe('isLandingVisitBeacon', () => {
  it('matches the beacon POST, versioned or not', () => {
    expect(isLandingVisitBeacon('/v1/landing/visits', 'POST')).toBe(true);
    expect(isLandingVisitBeacon('/landing/visits', 'post')).toBe(true);
    expect(isLandingVisitBeacon('/v1/landing/visits/', 'POST')).toBe(true);
    expect(isLandingVisitBeacon('/v1/landing/visits?x=1', 'POST')).toBe(true);
  });

  it('matches the absolute URL Sentry hands over', () => {
    expect(
      isLandingVisitBeacon('https://api.example.org/v1/landing/visits', 'POST'),
    ).toBe(true);
  });

  it('leaves the admin read alone', () => {
    expect(isLandingVisitBeacon('/v1/admin/landing/visits', 'POST')).toBe(
      false,
    );
    expect(
      isLandingVisitBeacon('/v1/admin/landing/visits?rangeDays=30', 'GET'),
    ).toBe(false);
  });

  it('matches the CORS preflight before the beacon', () => {
    expect(isLandingVisitBeacon('/v1/landing/visits', 'OPTIONS')).toBe(true);
  });

  it('leaves other methods and other landing routes alone', () => {
    expect(isLandingVisitBeacon('/v1/landing/visits', 'GET')).toBe(false);
    expect(isLandingVisitBeacon('/v1/landing/visits', undefined)).toBe(false);
    expect(isLandingVisitBeacon('/v1/landing/features', 'POST')).toBe(false);
    expect(isLandingVisitBeacon('/v1/landing/visits/extra', 'POST')).toBe(
      false,
    );
    expect(isLandingVisitBeacon(undefined, 'POST')).toBe(false);
  });
});

describe('dropLandingVisitRequest', () => {
  it('removes the URL, query string, body, headers and cookies of the beacon', () => {
    const request: {
      url?: string;
      method?: string;
      query_string?: unknown;
      data?: unknown;
      headers?: unknown;
      cookies?: unknown;
    } = {
      url: 'https://api.example.org/v1/landing/visits',
      method: 'POST',
      query_string: 'x=1',
      data: { source: 'instagram' },
      headers: {
        'x-forwarded-for': '203.0.113.7',
        'user-agent': 'Mozilla/5.0',
        referer: 'https://example.org/?invite=abc',
      },
      cookies: { session: 'opaque' },
    };
    expect(dropLandingVisitRequest(request)).toBe(true);
    expect(request).toEqual({ method: 'POST' });
    expect(request).not.toHaveProperty('headers');
    expect(request).not.toHaveProperty('cookies');
  });

  it('keeps every other request intact, headers and cookies included', () => {
    const headers = { 'user-agent': 'Mozilla/5.0' };
    const cookies = { session: 'opaque' };
    const request = {
      url: 'https://api.example.org/v1/admin/landing/visits',
      method: 'GET',
      headers,
      cookies,
    };
    expect(dropLandingVisitRequest(request)).toBe(false);
    expect(request.url).toBe('https://api.example.org/v1/admin/landing/visits');
    expect(request.headers).toEqual({ 'user-agent': 'Mozilla/5.0' });
    expect(request.cookies).toEqual({ session: 'opaque' });
  });
});
