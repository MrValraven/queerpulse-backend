import {
  dropLeadsReferer,
  dropLeadsUrl,
  isLeadsRequest,
  redactLeadsPath,
  REDACTED_LEADS_PATH,
  REDACTED_LEADS_QUERY,
} from './leads-request-log';

const LEAD_ID = '2f0c7e9e-0000-4000-8000-000000000001';
const ENTRY_ID = '2f0c7e9e-0000-4000-8000-000000000002';

describe('isLeadsRequest', () => {
  it.each([
    '/v1/admin/leads',
    '/admin/leads/',
    '/v1/admin/leads?q=ana',
    '/v1/admin/leads/due-count',
    `/v1/admin/leads/${LEAD_ID}/entries/${ENTRY_ID}`,
    '/V1/ADMIN/LEADS',
  ])('recognises the leads API path %s', (url) => {
    expect(isLeadsRequest(url)).toBe(true);
  });

  it.each([
    '/v1/admin/leadsx',
    '/v1/admin/music-events',
    '/v1/leads',
    '',
    undefined,
  ])('leaves %s alone', (url) => {
    expect(isLeadsRequest(url)).toBe(false);
  });
});

describe('dropLeadsUrl', () => {
  it('drops the url, query string and body of a leads request', () => {
    const request = {
      url: 'https://api.queerpulse.test/v1/admin/leads?q=ana',
      query_string: 'q=ana',
      data: '{"name":"Ana"}',
      method: 'POST',
    };
    expect(dropLeadsUrl(request)).toBe(true);
    expect(request).toEqual({ method: 'POST' });
  });

  it('keeps every field of another request', () => {
    const request = {
      url: 'https://api.queerpulse.test/v1/events',
      query_string: 'page=2',
      data: '{}',
      method: 'POST',
    };
    expect(dropLeadsUrl(request)).toBe(false);
    expect(request).toEqual({
      url: 'https://api.queerpulse.test/v1/events',
      query_string: 'page=2',
      data: '{}',
      method: 'POST',
    });
  });

  it('answers false for a missing request', () => {
    expect(dropLeadsUrl(undefined)).toBe(false);
  });
});

describe('dropLeadsReferer', () => {
  it('drops a referer naming a leads page in any key casing', () => {
    const request = {
      headers: { Referer: 'https://queerpulse.test/admin/leads/abc' },
    };
    expect(dropLeadsReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('drops a referer naming a leads API route', () => {
    const request = {
      headers: { referer: 'https://api.queerpulse.test/v1/admin/leads?q=a' },
    };
    expect(dropLeadsReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('keeps an unrelated referer', () => {
    const request = {
      headers: { referer: 'https://queerpulse.test/feed' },
    };
    expect(dropLeadsReferer(request)).toBe(false);
    expect(request.headers).toEqual({
      referer: 'https://queerpulse.test/feed',
    });
  });
});

describe('redactLeadsPath', () => {
  it('keeps the route base and redacts the tail and the query', () => {
    expect(redactLeadsPath('/v1/admin/leads?q=ana')).toBe(
      `/v1/admin/leads?${REDACTED_LEADS_QUERY}`,
    );
    expect(
      redactLeadsPath(`/v1/admin/leads/${LEAD_ID}/entries/${ENTRY_ID}`),
    ).toBe(`/v1/admin/leads/${REDACTED_LEADS_PATH}`);
    expect(redactLeadsPath('/v1/admin/leads')).toBe('/v1/admin/leads');
    expect(redactLeadsPath('/v1/events?q=a')).toBe('/v1/events?q=a');
    expect(redactLeadsPath(undefined)).toBeUndefined();
  });

  it('writes the placeholders the contract names', () => {
    expect(REDACTED_LEADS_PATH).toBe('[lead]');
    expect(REDACTED_LEADS_QUERY).toBe('[query]');
  });
});
