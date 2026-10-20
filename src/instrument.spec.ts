import type * as Sentry from '@sentry/node';
import type * as InstrumentModule from './instrument';

// `instrument.ts` calls `initSentry()` as it loads, so a shell that exports
// SENTRY_DSN would start the real SDK inside Jest. The module is loaded only
// after the variable is cleared, and the variable is put back afterwards.
const originalSentryDsn = process.env.SENTRY_DSN;
let scrubSensitiveQueryParameters: typeof InstrumentModule.scrubSensitiveQueryParameters;

beforeAll(() => {
  delete process.env.SENTRY_DSN;
  jest.isolateModules(() => {
    ({ scrubSensitiveQueryParameters } =
      jest.requireActual<typeof InstrumentModule>('./instrument'));
  });
});

afterAll(() => {
  if (originalSentryDsn === undefined) {
    delete process.env.SENTRY_DSN;
  } else {
    process.env.SENTRY_DSN = originalSentryDsn;
  }
});

function eventWithHeaders(headers: Record<string, string>): Sentry.ErrorEvent {
  return {
    type: undefined,
    request: { url: 'https://api.queerpulse.test/feed', headers },
  };
}

describe('scrubSensitiveQueryParameters referer', () => {
  it('removes a frontend collection referer', () => {
    const event = scrubSensitiveQueryParameters(
      eventWithHeaders({
        referer: 'https://queerpulse.test/studio/collection?id=abc',
      }),
    );
    expect(event.request?.headers).toEqual({});
  });

  it('keeps the referer of an unrelated page', () => {
    const event = scrubSensitiveQueryParameters(
      eventWithHeaders({ referer: 'https://queerpulse.test/feed' }),
    );
    expect(event.request?.headers?.referer).toBe(
      'https://queerpulse.test/feed',
    );
  });

  it('redacts a sensitive query value on a kept referer', () => {
    const event = scrubSensitiveQueryParameters(
      eventWithHeaders({ Referer: 'https://queerpulse.test/feed?invite=abc' }),
    );
    expect(event.request?.headers?.Referer).toBe(
      'https://queerpulse.test/feed?invite=[redacted]',
    );
  });

  it('handles an upper-case Referer key', () => {
    const event = scrubSensitiveQueryParameters(
      eventWithHeaders({ Referer: 'https://queerpulse.test/studio/album/1' }),
    );
    expect(event.request?.headers).toEqual({});
  });
});

describe('scrubSensitiveQueryParameters Studio url values', () => {
  const TRACK_URL = 'https://queerpulse.test/studio/track?id=abc';

  it('redacts a Studio url in a parsed query object', () => {
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: {
        url: 'https://api.queerpulse.test/link-preview',
        query_string: { url: TRACK_URL, page: '2' },
      },
    });
    expect(event.request?.query_string).toEqual({
      url: '[redacted]',
      page: '2',
    });
  });

  it('redacts a Studio url in parsed query pairs', () => {
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: {
        url: 'https://api.queerpulse.test/link-preview',
        query_string: [
          ['url', TRACK_URL],
          ['page', '2'],
        ],
      },
    });
    expect(event.request?.query_string).toEqual([
      ['url', '[redacted]'],
      ['page', '2'],
    ]);
  });

  it('redacts a Studio url on the request url', () => {
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: {
        url: `https://api.queerpulse.test/link-preview?url=${encodeURIComponent(TRACK_URL)}`,
      },
    });
    expect(event.request?.url).toBe(
      'https://api.queerpulse.test/link-preview?url=[redacted]',
    );
  });
});

describe('scrubSensitiveQueryParameters giving body', () => {
  const GIVING_BODY =
    '{"methods":[{"kind":"iban","value":"PT50000201231234567890154"}]}';

  it('drops the body of a giving save', () => {
    const givingUrl =
      'https://api.queerpulse.test/v1/communities/lisbon-queer/giving';
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: { url: givingUrl, method: 'PUT', data: GIVING_BODY },
    });
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.url).toBe(givingUrl);
  });

  it('keeps the body of other routes', () => {
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: {
        url: 'https://api.queerpulse.test/v1/communities/lisbon-queer/resources',
        method: 'PUT',
        data: GIVING_BODY,
      },
    });
    expect(event.request?.data).toBe(GIVING_BODY);
  });

  it('matches with a trailing slash and a query string', () => {
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: {
        url: 'https://api.queerpulse.test/v1/communities/lisbon-queer/giving/?x=1',
        method: 'PUT',
        data: GIVING_BODY,
      },
    });
    expect(event.request?.data).toBeUndefined();
  });
});

describe('scrubSensitiveQueryParameters creator drafts', () => {
  it('drops the url, query string and body of a creator draft save', () => {
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: {
        url: 'https://api.queerpulse.test/v1/me/creator-drafts/event',
        method: 'PUT',
        data: '{"payload":{"title":"x"}}',
        query_string: 'a=1',
      },
    });
    expect(event.request).toEqual({ method: 'PUT' });
  });

  it('drops a referer naming the admin creator drafts page', () => {
    const event = scrubSensitiveQueryParameters(
      eventWithHeaders({
        referer: 'https://queerpulse.test/admin/creator-drafts/persona/abc',
      }),
    );
    expect(event.request?.headers).toEqual({});
  });

  it('removes breadcrumbs that name a creator draft route and keeps the rest', () => {
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      breadcrumbs: [
        {
          category: 'http',
          data: {
            url: 'https://api.queerpulse.test/v1/admin/creator-drafts/event/abc',
          },
        },
        {
          category: 'http',
          data: { url: 'https://storage.test/object?X-Amz-Signature=secret' },
        },
      ],
    });
    expect(event.breadcrumbs).toHaveLength(1);
    expect(event.breadcrumbs?.[0]?.data?.url).not.toContain('creator-drafts');
  });
});

describe('scrubSensitiveQueryParameters Pulse Live body', () => {
  const JOIN_BODY = '{"code":"ABCD","screenName":"Lua"}';

  it('drops the body of a join', () => {
    const joinUrl = 'https://api.queerpulse.test/v1/quizshow/join';
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: { url: joinUrl, method: 'POST', data: JOIN_BODY },
    });
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.url).toBe(joinUrl);
  });

  it('keeps the body of other routes', () => {
    const event = scrubSensitiveQueryParameters({
      type: undefined,
      request: {
        url: 'https://api.queerpulse.test/v1/events/x/photos',
        method: 'POST',
        data: JOIN_BODY,
      },
    });
    expect(event.request?.data).toBe(JOIN_BODY);
  });
});
