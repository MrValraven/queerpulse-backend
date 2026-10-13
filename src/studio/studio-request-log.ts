/**
 * Studio records nothing about what a member listens to. The request log and
 * the HTTP metrics would otherwise name each streamed track, and a playlist
 * id beside a member id is a listening list, so both skip every request whose
 * path names a track (its page, stream or playlists) or a playlist (any
 * method, any subpath, `mine` included). Studio search is skipped too, with
 * any query string, so a search term never sits beside a member id. Case-blind,
 * and the staff routes under `/admin/studio/` are logged as usual.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */
export function isStudioListeningRequest(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const [path = ''] = url.split('?');
  if (path.toLowerCase().includes('/admin/studio/')) {
    return false;
  }
  return (
    /(?:^|\/)studio\/(?:tracks|playlists)\/[^/]+(?:\/|$)/i.test(path) ||
    /(?:^|\/)studio\/search\/?$/i.test(path)
  );
}

/** The request fields of a Sentry event that can carry a URL. */
export interface StudioListeningRequestFields {
  url?: string;
  query_string?: unknown;
}

/**
 * Sentry's half of the rule above: a Studio listening request reaches an
 * error report with its URL and query string removed, so the report keeps
 * the error and drops the track, playlist or search term. Answers whether it
 * removed anything.
 */
export function dropStudioListeningUrl(
  request: StudioListeningRequestFields | undefined,
): boolean {
  if (!request || !isStudioListeningRequest(request.url)) {
    return false;
  }
  delete request.url;
  delete request.query_string;
  return true;
}

/**
 * The frontend pages that show what a member listens to. A `Referer` header
 * naming one of them (`/studio/collection?id=<playlistId>`) would carry the
 * same listening list the request URL does, so Sentry drops the header too.
 */
const STUDIO_LISTENING_PAGE_PATTERN =
  /(?:^|\/)studio\/(?:collection|album|track|artist|set|live|search|library|browse)(?:\/|$)/i;

function isStudioListeningReferer(referer: string): boolean {
  try {
    const { pathname } = new URL(referer, 'http://placeholder');
    return (
      STUDIO_LISTENING_PAGE_PATTERN.test(pathname) ||
      isStudioListeningRequest(pathname)
    );
  } catch {
    // An unparseable referer cannot be shown to be harmless.
    return true;
  }
}

/**
 * Removes the `Referer` header (any key casing) from a Sentry request when it
 * points at a Studio listening page or API path, or cannot be parsed. Answers
 * whether it removed anything.
 */
export function dropStudioListeningReferer(
  request: { headers?: Record<string, unknown> } | undefined,
): boolean {
  const headers = request?.headers;
  if (!headers) {
    return false;
  }
  let hasDropped = false;
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() !== 'referer') {
      continue;
    }
    const value = headers[headerName];
    if (typeof value !== 'string' || isStudioListeningReferer(value)) {
      delete headers[headerName];
      hasDropped = true;
    }
  }
  return hasDropped;
}
