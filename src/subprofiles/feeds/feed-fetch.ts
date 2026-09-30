import {
  type SafeFetchFailure,
  type SafeFetchResult,
  safeFetch,
} from '../../link-preview/ssrf';
import { magicBytesMatchContentType } from '../../storage/served-object';
import type { FeedErrorCode } from '../entities/subprofile-feed.entity';

/**
 * The two outbound fetches persona feed import makes, both through the
 * SSRF-hardened `safeFetch` (public addresses only, every redirect hop
 * re-validated, sockets pinned to the vetted IP, byte caps enforced while
 * streaming): the feed XML itself, and the podcast art we copy into our own
 * storage. Nothing here touches the database or storage.
 */

const MB = 1024 * 1024;
export const FEED_MAX_BYTES = 10 * MB;
export const FEED_TIMEOUT_MS = 10_000;
export const FEED_MAX_REDIRECTS = 3;
export const FEED_IMAGE_MAX_BYTES = 5 * MB;
const USER_AGENT = 'QueerPulseBot/1.0 (+podcast-import)';

/** A feed that could not be read, carrying the code the owner is shown. */
export class FeedFetchError extends Error {
  constructor(readonly code: FeedErrorCode) {
    super(`Feed fetch failed: ${code}`);
    this.name = 'FeedFetchError';
  }
}

/** A `safeFetch` failure in the feed's error vocabulary. A refused private
 *  address reads as `unreachable`: from the owner's side it is a URL we could
 *  not reach, and naming the SSRF rule helps nobody. */
export function feedErrorCodeFor(failure: SafeFetchFailure): FeedErrorCode {
  switch (failure) {
    case 'timeout':
      return 'timeout';
    case 'http_error':
      return 'http_error';
    case 'too_large':
      return 'too_large';
    case 'unsupported_type':
      return 'not_a_feed';
    case 'blocked':
    case 'unreachable':
    case 'too_many_redirects':
      return 'unreachable';
  }
}

export interface ConditionalValidators {
  etag: string | null;
  lastModified: string | null;
}

export type FeedFetchResult =
  | { notModified: true; finalUrl: string }
  | {
      notModified: false;
      xml: string;
      finalUrl: string;
      etag: string | null;
      lastModified: string | null;
    };

/** Injectable seam for specs; production passes the real `safeFetch`. */
export type SafeFetcher = typeof safeFetch;

/**
 * GET a feed, conditionally when validators are given (a 304 is success with
 * nothing new). Throws {@link FeedFetchError} on any failure.
 */
export async function fetchFeedXml(
  url: string,
  validators: ConditionalValidators | null = null,
  fetcher: SafeFetcher = safeFetch,
): Promise<FeedFetchResult> {
  const headers: Record<string, string> = {};
  if (validators?.etag) headers['if-none-match'] = validators.etag;
  if (validators?.lastModified) {
    headers['if-modified-since'] = validators.lastModified;
  }
  const result: SafeFetchResult = await fetcher(url, {
    userAgent: USER_AGENT,
    accept:
      'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
    maxBytes: FEED_MAX_BYTES,
    overflow: 'error',
    timeoutMs: FEED_TIMEOUT_MS,
    maxRedirects: FEED_MAX_REDIRECTS,
    headers,
  });
  if (!result.ok) throw new FeedFetchError(feedErrorCodeFor(result.failure));
  if (result.notModified) {
    return { notModified: true, finalUrl: result.finalUrl };
  }
  return {
    notModified: false,
    xml: decodeXml(result.body, result.headers.get('content-type')),
    finalUrl: result.finalUrl,
    etag: headerValue(result.headers.get('etag'), 512),
    lastModified: headerValue(result.headers.get('last-modified'), 100),
  };
}

function headerValue(value: string | null, maxLength: number): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * Decode feed bytes with the charset the response or the XML declaration
 * names, falling back to UTF-8 (a label TextDecoder does not know is ignored
 * rather than trusted).
 */
export function decodeXml(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  const prolog = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const fromProlog = /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(
    prolog,
  )?.[1];
  for (const label of [fromHeader, fromProlog]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown label: try the next source.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** The image types we accept for podcast art, by their magic bytes. */
export const FEED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The accepted image type `bytes` actually is, judged by magic bytes alone
 * (never by the remote Content-Type, which a host can set to anything), or
 * null.
 */
export function sniffFeedImageType(bytes: Uint8Array): string | null {
  const prefix = bytes.subarray(0, 16);
  return (
    FEED_IMAGE_TYPES.find((contentType) =>
      magicBytesMatchContentType(prefix, contentType),
    ) ?? null
  );
}

// A remote Content-Type we are willing to read the body of. The magic-byte
// sniff is what decides the type; this only refuses a host that says outright
// it is sending something else (HTML, JSON, a video).
const PLAUSIBLE_IMAGE_CONTENT_TYPE =
  /^(image\/(jpeg|jpg|pjpeg|png|webp)|application\/octet-stream|binary\/octet-stream)\b/i;

/**
 * Download one piece of podcast art (at most 5 MB, JPEG/PNG/WebP by magic
 * bytes). Returns null on ANY failure: art is best-effort and never fails an
 * import.
 */
export async function fetchFeedImage(
  url: string,
  fetcher: SafeFetcher = safeFetch,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const result = await fetcher(url, {
    userAgent: USER_AGENT,
    accept: 'image/jpeg, image/png, image/webp',
    maxBytes: FEED_IMAGE_MAX_BYTES,
    overflow: 'error',
    timeoutMs: FEED_TIMEOUT_MS,
    maxRedirects: FEED_MAX_REDIRECTS,
    acceptsContentType: (contentType) =>
      !contentType || PLAUSIBLE_IMAGE_CONTENT_TYPE.test(contentType.trim()),
  });
  if (!result.ok || result.notModified || result.body.byteLength === 0) {
    return null;
  }
  const contentType = sniffFeedImageType(result.body);
  return contentType ? { bytes: result.body, contentType } : null;
}
