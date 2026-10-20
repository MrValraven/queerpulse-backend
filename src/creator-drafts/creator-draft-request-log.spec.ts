import {
  dropCreatorDraftReferer,
  dropCreatorDraftUrl,
  isCreatorDraftRequest,
  redactCreatorDraftPath,
} from './creator-draft-request-log';

describe('isCreatorDraftRequest', () => {
  it.each([
    '/v1/me/creator-drafts/event',
    '/me/creator-drafts/community',
    '/v1/me/creator-drafts/listing-edit/QPL-2026-0001',
    '/v1/ADMIN/Creator-Drafts?kind=event&page=2',
    '/v1/admin/creator-drafts/persona/2f0c7e9e-0000-4000-8000-000000000001',
    '/v1/admin/listing-drafts',
    '/v1/admin/listing-drafts/2f0c7e9e-0000-4000-8000-000000000001',
    'https://api.queerpulse.test/v1/me/creator-drafts/event/',
  ])('matches %s', (url) => {
    expect(isCreatorDraftRequest(url)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '/v1/me/drafts',
    '/v1/listing-drafts',
    '/v1/me/creator-draftsx',
    '/v1/admin/listings?view=drafts',
    '/v1/events',
  ])('leaves %s alone', (url) => {
    expect(isCreatorDraftRequest(url)).toBe(false);
  });
});

describe('dropCreatorDraftUrl', () => {
  it('drops the url, the query string and the body of a draft request', () => {
    const request = {
      url: '/v1/me/creator-drafts/event',
      query_string: 'x=1',
      data: '{"payload":{}}',
    };
    expect(dropCreatorDraftUrl(request)).toBe(true);
    expect(request).toEqual({});
  });

  it('keeps every field of another request', () => {
    const request = { url: '/v1/events', data: '{}' };
    expect(dropCreatorDraftUrl(request)).toBe(false);
    expect(request).toEqual({ url: '/v1/events', data: '{}' });
  });
});

describe('dropCreatorDraftReferer', () => {
  it('drops a referer naming the admin creator drafts page, any key casing', () => {
    const request = {
      headers: {
        Referer: 'https://queerpulse.test/admin/creator-drafts/event/abc',
      },
    };
    expect(dropCreatorDraftReferer(request)).toBe(true);
    expect(request.headers).toEqual({});
  });

  it('keeps an unrelated referer', () => {
    const request = {
      headers: { referer: 'https://queerpulse.test/feed' },
    };
    expect(dropCreatorDraftReferer(request)).toBe(false);
  });
});

describe('redactCreatorDraftPath', () => {
  const draftId = '2f0c7e9e-0000-4000-8000-000000000001';

  it.each([
    ['/v1/me/creator-drafts/event', '/v1/me/creator-drafts/[draft]'],
    [
      '/v1/me/creator-drafts/listing-edit/QPL-2026-0001',
      '/v1/me/creator-drafts/[draft]',
    ],
    [
      `/v1/admin/creator-drafts/persona/${draftId}`,
      '/v1/admin/creator-drafts/[draft]',
    ],
    [
      '/v1/ADMIN/Creator-Drafts?kind=event&page=2',
      '/v1/ADMIN/Creator-Drafts?[query]',
    ],
    [
      `/admin/creator-drafts/event/${draftId}?view=full#top`,
      '/admin/creator-drafts/[draft]?[query]',
    ],
    ['/v1/me/creator-drafts/', '/v1/me/creator-drafts'],
    ['/v1/admin/creator-drafts', '/v1/admin/creator-drafts'],
  ])('redacts %s to %s', (url, expected) => {
    expect(redactCreatorDraftPath(url)).toBe(expected);
  });

  it.each([
    '/v1/events/2f0c7e9e-0000-4000-8000-000000000001',
    '/v1/me/creator-draftsx/event',
    '/v1/admin/listings?view=creator-drafts/event',
    '/v1/me/drafts/event',
  ])('leaves %s unchanged', (url) => {
    expect(redactCreatorDraftPath(url)).toBe(url);
  });

  it('passes an absent url through', () => {
    expect(redactCreatorDraftPath(undefined)).toBeUndefined();
  });
});
