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
