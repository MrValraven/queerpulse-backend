import { safeFetch, safeFetchHtml, type SafeFetchOptions } from './ssrf';

// Literal public IPs, so `assertPublicUrl` never needs DNS in these specs.
const PUBLIC = 'https://93.184.215.14';

const OPTIONS: SafeFetchOptions = {
  accept: 'application/rss+xml',
  userAgent: 'test',
  maxBytes: 8,
  overflow: 'error',
  timeoutMs: 1000,
};

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('safeFetch', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('refuses a private address without making a request', async () => {
    await expect(safeFetch('http://127.0.0.1/feed', OPTIONS)).resolves.toEqual({
      ok: false,
      failure: 'blocked',
    });
    await expect(
      safeFetch('http://169.254.169.254/latest', OPTIONS),
    ).resolves.toEqual({ ok: false, failure: 'blocked' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-validates every redirect hop', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://10.0.0.1/internal' },
      }),
    );
    await expect(safeFetch(`${PUBLIC}/feed`, OPTIONS)).resolves.toEqual({
      ok: false,
      failure: 'blocked',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stops after the redirect cap', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: `${PUBLIC}/again` },
        }),
      ),
    );
    await expect(
      safeFetch(`${PUBLIC}/feed`, { ...OPTIONS, maxRedirects: 2 }),
    ).resolves.toEqual({ ok: false, failure: 'too_many_redirects' });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('follows a public redirect and reports the final URL', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: '/moved' } }),
      )
      .mockResolvedValueOnce(new Response(streamOf('<rss/>'), { status: 200 }));
    const result = await safeFetch(`${PUBLIC}/feed`, OPTIONS);
    expect(result.ok && !result.notModified && result.finalUrl).toBe(
      `${PUBLIC}/moved`,
    );
  });

  it('passes conditional headers and reports a 304 as not modified', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const result = await safeFetch(`${PUBLIC}/feed`, {
      ...OPTIONS,
      headers: { 'if-none-match': '"v1"' },
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: true, notModified: true, status: 304 }),
    );
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual(
      expect.objectContaining({
        'if-none-match': '"v1"',
        accept: 'application/rss+xml',
      }),
    );
    expect(init.redirect).toBe('manual');
  });

  it('fails too_large past the cap, or truncates when asked to', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(streamOf('12345', '67890'), { status: 200 }),
    );
    await expect(safeFetch(`${PUBLIC}/feed`, OPTIONS)).resolves.toEqual({
      ok: false,
      failure: 'too_large',
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(streamOf('12345', '67890'), { status: 200 }),
    );
    const truncated = await safeFetch(`${PUBLIC}/feed`, {
      ...OPTIONS,
      overflow: 'truncate',
    });
    expect(
      truncated.ok &&
        !truncated.notModified &&
        new TextDecoder().decode(truncated.body),
    ).toBe('12345678');
  });

  it('classifies an HTTP error and a timeout', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    await expect(safeFetch(`${PUBLIC}/feed`, OPTIONS)).resolves.toEqual({
      ok: false,
      failure: 'http_error',
      status: 503,
    });

    fetchSpy.mockRejectedValueOnce(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    await expect(safeFetch(`${PUBLIC}/feed`, OPTIONS)).resolves.toEqual({
      ok: false,
      failure: 'timeout',
    });

    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(safeFetch(`${PUBLIC}/feed`, OPTIONS)).resolves.toEqual({
      ok: false,
      failure: 'unreachable',
    });
  });

  it('refuses a content type the caller does not accept, before reading', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(streamOf('<html>'), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(
      safeFetch(`${PUBLIC}/art`, {
        ...OPTIONS,
        acceptsContentType: (type) => type.startsWith('image/'),
      }),
    ).resolves.toEqual({
      ok: false,
      failure: 'unsupported_type',
      status: 200,
    });
  });
});

describe('safeFetchHtml (link preview)', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns the decoded HTML and final URL', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(streamOf('<head><title>Hi</title></head>'), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    await expect(safeFetchHtml(`${PUBLIC}/page`)).resolves.toEqual({
      html: '<head><title>Hi</title></head>',
      finalUrl: `${PUBLIC}/page`,
    });
  });

  it('is null for a non-HTML document, a private host, or an error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(streamOf('{}'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(safeFetchHtml(`${PUBLIC}/api`)).resolves.toBeNull();
    await expect(safeFetchHtml('http://127.0.0.1/')).resolves.toBeNull();
    fetchSpy.mockResolvedValueOnce(new Response('x', { status: 404 }));
    await expect(safeFetchHtml(`${PUBLIC}/missing`)).resolves.toBeNull();
  });
});
