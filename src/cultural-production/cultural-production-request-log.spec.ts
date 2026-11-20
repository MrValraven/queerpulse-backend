import {
  dropCulturalProductionReferer,
  dropCulturalProductionUrl,
  isCulturalProductionRequest,
  redactCulturalProductionPath,
  REDACTED_CULTURAL_PRODUCTION_PATH,
  REDACTED_CULTURAL_PRODUCTION_QUERY,
} from './cultural-production-request-log';

const IDEA_ID = '2f0c7e9e-0000-4000-8000-000000000001';
const TASK_ID = '2f0c7e9e-0000-4000-8000-000000000002';
const USER_ID = '2f0c7e9e-0000-4000-8000-000000000003';

describe('isCulturalProductionRequest', () => {
  it.each([
    '/admin/cultural-production',
    '/admin/cultural-production/',
    '/v1/admin/cultural-production',
    '/v1/admin/cultural-production/tasks/abc',
    '/v1/admin/cultural-production/staff?q=ana',
    `/v1/admin/cultural-production/ideas/${IDEA_ID}`,
    `/v1/admin/cultural-production/tasks/${TASK_ID}/assignees/${USER_ID}`,
    '/V1/ADMIN/CULTURAL-PRODUCTION',
    '/Admin/Cultural-Production/Tasks/abc',
  ])('recognises the Cultural Production API path %s', (url) => {
    expect(isCulturalProductionRequest(url)).toBe(true);
  });

  it.each([
    '/admin/cultural-productions',
    '/admin/culturalproduction',
    '/v1/admin/cultural-productionx/ideas',
    '/v1/admin/leads',
    '/v1/cultural-production',
    '',
    undefined,
  ])('leaves %s alone', (url) => {
    expect(isCulturalProductionRequest(url)).toBe(false);
  });
});

describe('dropCulturalProductionUrl', () => {
  it('drops the url, query string and body of a Cultural Production request', () => {
    const request = {
      url: 'https://api.queerpulse.test/v1/admin/cultural-production/staff?q=ana',
      query_string: 'q=ana',
      data: '{"title":"Board game night"}',
      method: 'POST',
    };
    expect(dropCulturalProductionUrl(request)).toBe(true);
    expect(request).toEqual({ method: 'POST' });
  });

  it('keeps every field of another request', () => {
    const request = {
      url: 'https://api.queerpulse.test/v1/events',
      query_string: 'page=2',
      data: '{}',
      method: 'POST',
    };
    expect(dropCulturalProductionUrl(request)).toBe(false);
    expect(request).toEqual({
      url: 'https://api.queerpulse.test/v1/events',
      query_string: 'page=2',
      data: '{}',
      method: 'POST',
    });
  });

  it('answers false for a missing request', () => {
    expect(dropCulturalProductionUrl(undefined)).toBe(false);
  });
});

describe('dropCulturalProductionReferer', () => {
  it.each(['Referer', 'referer', 'REFERER'])(
    'drops a referer naming the page under the header key %s',
    (headerName) => {
      const request = {
        headers: {
          [headerName]: 'https://queerpulse.test/admin/cultural-production/abc',
        },
      };
      expect(dropCulturalProductionReferer(request)).toBe(true);
      expect(request.headers).toEqual({});
    },
  );

  it('drops a referer naming a Cultural Production API route', () => {
    const request = {
      headers: {
        referer: 'https://api.queerpulse.test/v1/admin/cultural-production?q=a',
      },
    };
    expect(dropCulturalProductionReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('drops an unparseable referer', () => {
    const request = { headers: { referer: 'http://[bad' } };
    expect(dropCulturalProductionReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('keeps an unrelated referer and other headers', () => {
    const request = {
      headers: {
        referer: 'https://queerpulse.test/feed',
        accept: 'application/json',
      },
    };
    expect(dropCulturalProductionReferer(request)).toBe(false);
    expect(request.headers).toEqual({
      referer: 'https://queerpulse.test/feed',
      accept: 'application/json',
    });
  });

  it('answers false for a request without headers', () => {
    expect(dropCulturalProductionReferer(undefined)).toBe(false);
    expect(dropCulturalProductionReferer({})).toBe(false);
  });
});

describe('redactCulturalProductionPath', () => {
  it('keeps the route base and redacts the tail and the query', () => {
    expect(
      redactCulturalProductionPath(
        `/admin/cultural-production/ideas/${IDEA_ID}?x=1`,
      ),
    ).toBe(
      `/admin/cultural-production/${REDACTED_CULTURAL_PRODUCTION_PATH}?${REDACTED_CULTURAL_PRODUCTION_QUERY}`,
    );
    expect(
      redactCulturalProductionPath(
        `/v1/admin/cultural-production/tasks/${TASK_ID}/assignees/${USER_ID}`,
      ),
    ).toBe(
      `/v1/admin/cultural-production/${REDACTED_CULTURAL_PRODUCTION_PATH}`,
    );
    expect(redactCulturalProductionPath('/v1/admin/cultural-production')).toBe(
      '/v1/admin/cultural-production',
    );
    expect(
      redactCulturalProductionPath('/v1/admin/cultural-production?q=ana'),
    ).toBe(
      `/v1/admin/cultural-production?${REDACTED_CULTURAL_PRODUCTION_QUERY}`,
    );
  });

  it('redacts the staff picker path', () => {
    expect(
      redactCulturalProductionPath('/v1/admin/cultural-production/staff?q=ana'),
    ).toBe(
      `/v1/admin/cultural-production/${REDACTED_CULTURAL_PRODUCTION_PATH}?${REDACTED_CULTURAL_PRODUCTION_QUERY}`,
    );
  });

  it('leaves other URLs alone', () => {
    expect(redactCulturalProductionPath('/v1/events?q=a')).toBe(
      '/v1/events?q=a',
    );
    expect(
      redactCulturalProductionPath('/admin/cultural-productions/abc'),
    ).toBe('/admin/cultural-productions/abc');
    expect(redactCulturalProductionPath(undefined)).toBeUndefined();
  });

  it('writes the placeholders the contract names', () => {
    expect(REDACTED_CULTURAL_PRODUCTION_PATH).toBe('[cultural]');
    expect(REDACTED_CULTURAL_PRODUCTION_QUERY).toBe('[query]');
  });
});
