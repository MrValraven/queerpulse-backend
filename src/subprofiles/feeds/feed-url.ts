import { MAX_FEED_URL_LENGTH } from './feed-parse';

// The podcast-app pseudo-schemes a "subscribe" button hands out. Each wraps an
// ordinary web URL, with or without its own `http(s)://`.
const PODCAST_PSEUDO_SCHEME = /^(feed|itpc|pcast|podcast):(\/\/)?/i;

/**
 * The URL a member pasted, as the absolute http(s) URL we fetch, or null when
 * it cannot be one. A scheme-less value (`feeds.example.com/show`) and the
 * podcast pseudo-schemes (`feed://`, `itpc://`, `pcast://`, `podcast://`)
 * become https. Credentials in the URL are refused (they would be sent to
 * whatever host the feed redirects to) and the fragment is dropped (it never
 * reaches the server and would only split one feed into two "different"
 * URLs). Whether the host is public is decided at fetch time by the SSRF
 * guard, never here.
 */
export function normalizeFeedUrl(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (PODCAST_PSEUDO_SCHEME.test(value)) {
    value = value.replace(PODCAST_PSEUDO_SCHEME, '');
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  parsed.hash = '';
  const normalized = parsed.toString();
  return normalized.length <= MAX_FEED_URL_LENGTH ? normalized : null;
}
