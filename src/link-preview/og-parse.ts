import { LinkPreviewResponse } from './link-preview.response';

/**
 * A tiny, dependency-free OpenGraph / Twitter-card / <title> extractor. We
 * deliberately avoid a heavyweight scraping/DOM library: unfurl metadata lives
 * in flat <meta> tags in the document <head>, so a handful of regexes over the
 * first slice of HTML is enough and keeps the attack surface + install size
 * small. Precedence per field: OpenGraph → Twitter → sensible fallback.
 */

/** Only the head matters for meta tags; cap the scan so a huge body is cheap. */
const HEAD_SCAN_LIMIT = 128 * 1024;

/** Pull the `content` value of the first <meta> whose property/name matches. */
function metaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match either attribute order: property/name before content, or after.
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
        'i',
      ),
      new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["']`,
        'i',
      ),
    ];
    for (const pattern of patterns) {
      const content = html.match(pattern)?.[1]?.trim();
      if (content) return decodeEntities(content);
    }
  }
  return null;
}

/** The document <title>, as a last-resort headline. */
function documentTitle(html: string): string | null {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  return title ? decodeEntities(title) : null;
}

/** Minimal HTML-entity decode for the handful that show up in meta content. */
function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    );
}

/** Clamp a field so an oversized/abusive value can't bloat the response. */
function clamp(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * Build a hand-mapped preview DTO from an HTML document. `finalUrl` is the
 * post-redirect URL, used to derive a fallback site name and to resolve a
 * relative og:image. Returns an all-null-ish card when nothing usable is found;
 * the caller decides whether that's worth returning.
 */
export function parseOpenGraph(
  html: string,
  finalUrl: string,
): LinkPreviewResponse {
  const head = html.slice(0, HEAD_SCAN_LIMIT);

  const title = clamp(
    metaContent(head, ['og:title', 'twitter:title']) ?? documentTitle(head),
    200,
  );
  const description = clamp(
    metaContent(head, ['og:description', 'twitter:description', 'description']),
    300,
  );
  const rawImage = metaContent(head, [
    'og:image:secure_url',
    'og:image:url',
    'og:image',
    'twitter:image',
    'twitter:image:src',
  ]);

  let siteName = metaContent(head, ['og:site_name', 'application-name']);
  let imageUrl: string | null = null;
  try {
    const base = new URL(finalUrl);
    if (!siteName) siteName = base.hostname.replace(/^www\./, '');
    if (rawImage) {
      const resolved = new URL(rawImage, base);
      // Only surface an http(s) image; never a data:/file: URI back to the client.
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        imageUrl = resolved.toString();
      }
    }
  } catch {
    // finalUrl should always parse (it already passed the fetcher), but guard.
  }

  return {
    url: finalUrl,
    siteName: clamp(siteName, 120),
    title,
    description,
    imageUrl,
  };
}
