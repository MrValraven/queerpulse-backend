import {
  dropStudioLandingPublicRequest,
  isStudioLandingPublicRequest,
} from './studio-landing-request-log';

const PREVIEW_ID = '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a';

describe('isStudioLandingPublicRequest', () => {
  it.each([
    '/studio/landing',
    '/v1/studio/landing',
    '/studio/landing/',
    `/v1/studio/landing/previews/${PREVIEW_ID}/stream`,
    '/Studio/Landing?x=1',
  ])('matches %s', (url) => {
    expect(isStudioLandingPublicRequest(url, 'GET')).toBe(true);
  });

  it.each([
    '/admin/studio/landing',
    '/studio/landingx',
    `/studio/landing/previews/${PREVIEW_ID}`,
    '/studio/landing/previews/x/stream/extra',
    '/landing/features',
  ])('ignores %s', (url) => {
    expect(isStudioLandingPublicRequest(url, 'GET')).toBe(false);
  });

  it('skips GET, HEAD and OPTIONS on both public routes', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isStudioLandingPublicRequest('/studio/landing', method)).toBe(
        true,
      );
      expect(
        isStudioLandingPublicRequest(
          `/studio/landing/previews/${PREVIEW_ID}/stream`,
          method,
        ),
      ).toBe(true);
    }
    expect(isStudioLandingPublicRequest('/studio/landing', 'POST')).toBe(false);
  });

  it('ignores a missing url or method', () => {
    expect(isStudioLandingPublicRequest(undefined, 'GET')).toBe(false);
    expect(isStudioLandingPublicRequest('', 'GET')).toBe(false);
    expect(isStudioLandingPublicRequest('/studio/landing', undefined)).toBe(
      false,
    );
  });
});

describe('dropStudioLandingPublicRequest', () => {
  it('drops url, query, body, headers and cookies from a Sentry request', () => {
    const request: {
      url?: string;
      method?: string;
      query_string?: unknown;
      data?: unknown;
      headers?: unknown;
      cookies?: unknown;
    } = {
      url: 'https://api.test/v1/studio/landing',
      method: 'GET',
      query_string: 'a=1',
      data: {},
      headers: { 'x-forwarded-for': '1.2.3.4' },
      cookies: { a: 'b' },
    };
    expect(dropStudioLandingPublicRequest(request)).toBe(true);
    expect(request).toEqual({ method: 'GET' });
  });

  it('leaves any other request untouched', () => {
    const request = {
      url: 'https://api.test/v1/studio/tracks',
      method: 'GET',
      query_string: 'a=1',
      headers: { 'user-agent': 'test' },
    };
    const before = { ...request };
    expect(dropStudioLandingPublicRequest(request)).toBe(false);
    expect(request).toEqual(before);
    expect(dropStudioLandingPublicRequest(undefined)).toBe(false);
  });
});
