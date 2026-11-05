import {
  dropVjReferer,
  dropVjUrl,
  isVjRequest,
  redactVjPath,
  REDACTED_VJ_PATH,
  REDACTED_VJ_QUERY,
} from './vj-request-log';

const PACK_ID = '2f0c7e9e-0000-4000-8000-000000000001';
const CLIP_ID = '2f0c7e9e-0000-4000-8000-000000000002';

describe('isVjRequest', () => {
  it('recognises every VJ API path and nothing else', () => {
    const vjPaths = [
      '/v1/admin/vj',
      '/admin/vj/',
      '/v1/admin/vj/packs',
      `/v1/admin/vj/packs/${PACK_ID}/media?clipIds=${CLIP_ID}`,
      '/V1/ADMIN/VJ/CLIPS',
    ];
    const otherPaths = [
      '/v1/admin/vjx',
      '/v1/admin/leads',
      '/v1/vj',
      '/files/vj-clips/a/b.mp4',
      '',
      undefined,
    ];
    for (const url of vjPaths) {
      expect(isVjRequest(url)).toBe(true);
    }
    for (const url of otherPaths) {
      expect(isVjRequest(url)).toBe(false);
    }
  });
});

describe('dropVjUrl', () => {
  it('drops the url, query string and body of a VJ request', () => {
    const request = {
      url: 'https://api.queerpulse.test/v1/admin/vj/clips',
      query_string: 'clipIds=a',
      data: '{"title":"Secret title"}',
      method: 'POST',
    };
    expect(dropVjUrl(request)).toBe(true);
    expect(request).toEqual({ method: 'POST' });
  });

  it('keeps every field of another request', () => {
    const request = {
      url: 'https://api.queerpulse.test/v1/events',
      query_string: 'page=2',
      data: '{}',
      method: 'POST',
    };
    expect(dropVjUrl(request)).toBe(false);
    expect(request).toEqual({
      url: 'https://api.queerpulse.test/v1/events',
      query_string: 'page=2',
      data: '{}',
      method: 'POST',
    });
  });

  it('answers false for a missing request', () => {
    expect(dropVjUrl(undefined)).toBe(false);
  });
});

describe('dropVjReferer', () => {
  it('drops a referer naming a VJ page or route in any casing', () => {
    const pageRequest = {
      headers: { Referer: 'https://queerpulse.test/admin/vj/remote' },
    };
    expect(dropVjReferer(pageRequest)).toBe(true);
    expect(pageRequest.headers).toEqual({});

    const routeRequest = {
      headers: { referer: 'https://api.queerpulse.test/v1/admin/vj/packs?x=1' },
    };
    expect(dropVjReferer(routeRequest)).toBe(true);
    expect(routeRequest.headers).toEqual({});

    const shoutingRequest = {
      headers: { REFERER: 'https://queerpulse.test/ADMIN/VJ/screen' },
    };
    expect(dropVjReferer(shoutingRequest)).toBe(true);
    expect(shoutingRequest.headers).toEqual({});
  });

  it('keeps an unrelated referer', () => {
    const request = {
      headers: { referer: 'https://queerpulse.test/feed' },
    };
    expect(dropVjReferer(request)).toBe(false);
    expect(request.headers).toEqual({
      referer: 'https://queerpulse.test/feed',
    });
  });

  it('answers false for a request with no headers', () => {
    expect(dropVjReferer(undefined)).toBe(false);
    expect(dropVjReferer({})).toBe(false);
  });
});

describe('redactVjPath', () => {
  it('keeps the route base and redacts the tail and the query', () => {
    expect(redactVjPath(`/v1/admin/vj/packs/${PACK_ID}/media?clipIds=a`)).toBe(
      `/v1/admin/vj/${REDACTED_VJ_PATH}?${REDACTED_VJ_QUERY}`,
    );
    expect(redactVjPath('/v1/admin/vj')).toBe('/v1/admin/vj');
    expect(redactVjPath('/v1/events?q=a')).toBe('/v1/events?q=a');
    expect(redactVjPath(undefined)).toBeUndefined();
  });

  it('writes the placeholders the contract names', () => {
    expect(REDACTED_VJ_PATH).toBe('[vj]');
    expect(REDACTED_VJ_QUERY).toBe('[query]');
  });
});
