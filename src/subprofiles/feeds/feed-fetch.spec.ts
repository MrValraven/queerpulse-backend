import type {
  SafeFetchOptions,
  SafeFetchResult,
} from '../../link-preview/ssrf';
import {
  FEED_IMAGE_MAX_BYTES,
  FEED_MAX_BYTES,
  FeedFetchError,
  decodeXml,
  feedErrorCodeFor,
  fetchFeedImage,
  fetchFeedXml,
  sniffFeedImageType,
} from './feed-fetch';

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
]);
const GIF = new TextEncoder().encode('GIF89a..........');

function okBody(
  body: Uint8Array,
  headers: Record<string, string> = {},
): SafeFetchResult {
  return {
    ok: true,
    notModified: false,
    status: 200,
    body,
    finalUrl: 'https://final.example/feed',
    headers: new Headers(headers),
  };
}

describe('fetchFeedXml', () => {
  it('fetches with the feed budget and returns the validators', async () => {
    const fetcher = jest.fn<
      Promise<SafeFetchResult>,
      [string, SafeFetchOptions]
    >(() =>
      Promise.resolve(
        okBody(new TextEncoder().encode('<rss/>'), {
          etag: '"v1"',
          'last-modified': 'Tue, 10 Jun 2025 04:00:00 GMT',
        }),
      ),
    );
    const result = await fetchFeedXml(
      'https://feed.example/rss',
      null,
      fetcher,
    );
    expect(result).toEqual({
      notModified: false,
      xml: '<rss/>',
      finalUrl: 'https://final.example/feed',
      etag: '"v1"',
      lastModified: 'Tue, 10 Jun 2025 04:00:00 GMT',
    });
    const [, options] = fetcher.mock.calls[0]!;
    expect(options).toEqual(
      expect.objectContaining({
        maxBytes: FEED_MAX_BYTES,
        overflow: 'error',
        timeoutMs: 10_000,
        maxRedirects: 3,
        headers: {},
      }),
    );
    expect(options.accept).toContain('application/rss+xml');
  });

  it('sends If-None-Match / If-Modified-Since and reports a 304', async () => {
    const fetcher = jest.fn<
      Promise<SafeFetchResult>,
      [string, SafeFetchOptions]
    >(() =>
      Promise.resolve({
        ok: true,
        notModified: true,
        status: 304,
        finalUrl: 'https://feed.example/rss',
        headers: new Headers(),
      }),
    );
    const result = await fetchFeedXml(
      'https://feed.example/rss',
      { etag: '"v1"', lastModified: 'Tue, 10 Jun 2025 04:00:00 GMT' },
      fetcher,
    );
    expect(result).toEqual({
      notModified: true,
      finalUrl: 'https://feed.example/rss',
    });
    expect(fetcher.mock.calls[0]![1].headers).toEqual({
      'if-none-match': '"v1"',
      'if-modified-since': 'Tue, 10 Jun 2025 04:00:00 GMT',
    });
  });

  it.each([
    ['blocked', 'unreachable'],
    ['unreachable', 'unreachable'],
    ['too_many_redirects', 'unreachable'],
    ['timeout', 'timeout'],
    ['http_error', 'http_error'],
    ['too_large', 'too_large'],
  ] as const)('maps a %s failure to %s', async (failure, code) => {
    const fetcher = jest.fn(() =>
      Promise.resolve({ ok: false, failure } as SafeFetchResult),
    );
    const error: unknown = await fetchFeedXml(
      'https://x.example',
      null,
      fetcher,
    )
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FeedFetchError);
    expect((error as FeedFetchError).code).toBe(code);
    expect(feedErrorCodeFor(failure)).toBe(code);
  });

  it('drops an oversized validator instead of storing it', async () => {
    const fetcher = jest.fn(() =>
      Promise.resolve(
        okBody(new TextEncoder().encode('<rss/>'), { etag: 'x'.repeat(600) }),
      ),
    );
    const result = await fetchFeedXml('https://x.example', null, fetcher);
    expect(result.notModified === false && result.etag).toBeNull();
  });
});

describe('decodeXml', () => {
  it('honours the charset of the response', () => {
    const latin1 = Uint8Array.from([0x43, 0x61, 0x66, 0xe9]); // "Café"
    expect(decodeXml(latin1, 'application/rss+xml; charset=ISO-8859-1')).toBe(
      'Café',
    );
  });

  it('honours the XML declaration when the header is silent', () => {
    const prolog = new TextEncoder().encode(
      '<?xml version="1.0" encoding="windows-1252"?><t>',
    );
    const bytes = new Uint8Array(prolog.length + 1);
    bytes.set(prolog);
    bytes[prolog.length] = 0x93; // left double quote in windows-1252
    expect(decodeXml(bytes, 'text/xml')).toContain('“');
  });

  it('falls back to UTF-8 for an unknown label', () => {
    expect(
      decodeXml(new TextEncoder().encode('Olá'), 'text/xml; charset=bogus'),
    ).toBe('Olá');
  });
});

describe('sniffFeedImageType', () => {
  it('recognises JPEG, PNG and WebP by magic bytes only', () => {
    expect(sniffFeedImageType(JPEG)).toBe('image/jpeg');
    expect(sniffFeedImageType(PNG)).toBe('image/png');
    expect(sniffFeedImageType(WEBP)).toBe('image/webp');
    expect(sniffFeedImageType(GIF)).toBeNull();
    expect(
      sniffFeedImageType(new TextEncoder().encode('<svg onload=x()>')),
    ).toBeNull();
  });
});

describe('fetchFeedImage', () => {
  it('returns the bytes with the sniffed type, whatever the host claims', async () => {
    const fetcher = jest.fn<
      Promise<SafeFetchResult>,
      [string, SafeFetchOptions]
    >(() => Promise.resolve(okBody(PNG, { 'content-type': 'image/jpeg' })));
    await expect(
      fetchFeedImage('https://cdn.example/art', fetcher),
    ).resolves.toEqual({ bytes: PNG, contentType: 'image/png' });
    const [, options] = fetcher.mock.calls[0]!;
    expect(options.maxBytes).toBe(FEED_IMAGE_MAX_BYTES);
    expect(options.overflow).toBe('error');
    expect(options.acceptsContentType?.('image/png')).toBe(true);
    expect(options.acceptsContentType?.('application/octet-stream')).toBe(true);
    expect(options.acceptsContentType?.('')).toBe(true);
    expect(options.acceptsContentType?.('text/html')).toBe(false);
    expect(options.acceptsContentType?.('image/svg+xml')).toBe(false);
  });

  it('is null for a non-image body or any fetch failure', async () => {
    await expect(
      fetchFeedImage('https://cdn.example/art', () =>
        Promise.resolve(okBody(GIF)),
      ),
    ).resolves.toBeNull();
    await expect(
      fetchFeedImage('https://cdn.example/art', () =>
        Promise.resolve({ ok: false, failure: 'too_large' }),
      ),
    ).resolves.toBeNull();
  });
});
