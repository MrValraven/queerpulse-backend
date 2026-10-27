/**
 * Studio keeps play totals and the member's own listening history, and
 * neither ever sits beside a member id in a log line. The request log and
 * the HTTP metrics would otherwise name each streamed track, and a playlist
 * id beside a member id is a listening list, so both skip every request whose
 * path names a track (its page, stream, playlists or persona credits) or a
 * playlist (any method, any subpath, `mine` included). Studio search and
 * Studio radio are skipped too, with any query string, so a search term or a
 * radio genre or mood never sits beside a member id. Studio v3 adds the
 * private preview routes (`/studio/previews/<token>`, any subpath, so no
 * token and no opener is ever logged) and the press kit read
 * (`/studio/artists/<id>/press-kit`, any method). The Studio dashboard adds
 * the owner reads (`/studio/artists/<id>/stats`, `placements` and
 * `milestones`, any subpath) and the milestone card read
 * (`/studio/milestones/<id>`), any method, so a persona id never sits beside
 * the member id of one of its owners. Studio listening adds the play count
 * (`/studio/plays`), the member's history routes (`/me/studio-listening`, any
 * subpath) and the owner reads `plays` and `supporters` plus the listener's
 * `supporter` route under `/studio/artists/<id>/`, any method. Studio artist kinds add
 * the format list (`/studio/formats`) and the episode routes
 * (`/studio/episodes/<anything>`, any subpath); an episode publish is
 * already a `/studio/tracks/<id>` path. Liked songs adds the like and unlike
 * calls: a `PUT` or `DELETE` on `/me/saved/studio_<kind>:<id>` (the colon
 * raw or encoded as `%3A`) names a liked track, release or playlist, so it
 * is skipped too, and so is the same Studio item added to or taken out of a
 * saved list (`/me/saved/lists/<listId>/items/studio_<kind>:<id>`);
 * `GET /studio/playlists/liked` is already a playlists path. The plain
 * `/me/saved` list, its `?kind=` filter, a list itself
 * (`/me/saved/lists/<listId>`) and list items of other kinds name no Studio
 * item and are logged as usual. Studio rich cards add the release read: a
 * `GET` (or `HEAD`) on `/studio/releases/<id>` itself, which every release
 * card fires. The owner edit and delete on that path and the owner tools
 * under it (`/studio/releases/<id>/preview-link` and the rest) are logged as
 * usual. A caller that passes no method counts as a read, so the release path
 * is skipped when in doubt. Case-blind, and the staff routes under
 * `/admin/studio/` are logged as usual.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */
export function isStudioListeningRequest(
  url: string | undefined,
  method?: string,
): boolean {
  if (!url) {
    return false;
  }
  const [path = ''] = url.split('?');
  if (path.toLowerCase().includes('/admin/studio/')) {
    return false;
  }
  return (
    /(?:^|\/)studio\/(?:tracks|playlists|previews|episodes)\/[^/]+(?:\/|$)/i.test(
      path,
    ) ||
    (STUDIO_RELEASE_READ_PATTERN.test(path) && isReadMethod(method)) ||
    /(?:^|\/)studio\/artists\/[^/]+\/press-kit\/?$/i.test(path) ||
    /(?:^|\/)studio\/artists\/[^/]+\/(?:stats|plays|placements|milestones|supporters?)(?:\/|$)/i.test(
      path,
    ) ||
    /(?:^|\/)studio\/milestones\/[^/]+(?:\/|$)/i.test(path) ||
    /(?:^|\/)studio\/plays\/?$/i.test(path) ||
    /(?:^|\/)me\/studio-listening(?:\/|$)/i.test(path) ||
    /(?:^|\/)studio\/search\/?$/i.test(path) ||
    /(?:^|\/)studio\/radio\/?$/i.test(path) ||
    /(?:^|\/)studio\/formats\/?$/i.test(path) ||
    /(?:^|\/)me\/saved\/(?:lists\/[^/]+\/items\/)?studio_(?:release|track|playlist)(?::|%3a)/i.test(
      path,
    )
  );
}

/** `/studio/releases/<id>` with nothing after the id but an optional slash. */
const STUDIO_RELEASE_READ_PATTERN =
  /(?:^|\/)studio\/releases\/[^/?#]+\/?(?:[?#]|$)/i;

/** GET and HEAD read; an absent method reads too, so a doubtful case is skipped. */
function isReadMethod(method: string | undefined): boolean {
  if (method === undefined) {
    return true;
  }
  const upperCaseMethod = method.toUpperCase();
  return upperCaseMethod === 'GET' || upperCaseMethod === 'HEAD';
}

/** What a logged preview URL shows where the bearer token was. */
export const REDACTED_PREVIEW_TOKEN = '[token]';

const STUDIO_PREVIEW_TOKEN_PATTERN = /((?:^|\/)studio\/previews\/)[^/?#]+/gi;

/**
 * The completion line of a preview request is skipped (see
 * `isStudioListeningRequest`), yet every other line logged inside that
 * request (an error from `AllExceptionsFilter`, say) still carries the
 * serialized `req.url`. A preview token is a bearer credential, so the
 * request serializer swaps the path segment after `/studio/previews/` for
 * `[token]` and keeps the rest of the path and the query string for
 * debugging. Every other URL comes back unchanged.
 */
export function redactStudioPreviewToken(url: string): string;
export function redactStudioPreviewToken(
  url: string | undefined,
): string | undefined;
export function redactStudioPreviewToken(
  url: string | undefined,
): string | undefined {
  if (typeof url !== 'string') {
    return url;
  }
  const queryStartIndex = url.indexOf('?');
  const path = queryStartIndex === -1 ? url : url.slice(0, queryStartIndex);
  const rest = queryStartIndex === -1 ? '' : url.slice(queryStartIndex);
  return (
    path.replace(STUDIO_PREVIEW_TOKEN_PATTERN, `$1${REDACTED_PREVIEW_TOKEN}`) +
    rest
  );
}

/** The request fields of a Sentry event that can carry a URL, with its method. */
export interface StudioListeningRequestFields {
  url?: string;
  query_string?: unknown;
  data?: unknown;
  method?: string;
}

/**
 * Sentry's half of the rule above: a Studio listening request reaches an
 * error report with its URL, query string and body (`data`, such as a
 * `{ trackId }` play count) removed, so the report keeps
 * the error and drops the track, playlist or search term. Answers whether it
 * removed anything.
 */
export function dropStudioListeningUrl(
  request: StudioListeningRequestFields | undefined,
): boolean {
  if (!request || !isStudioListeningRequest(request.url, request.method)) {
    return false;
  }
  delete request.url;
  delete request.query_string;
  delete request.data;
  return true;
}

/**
 * The frontend pages that show what a member listens to. A `Referer` header
 * naming one of them (`/studio/collection?id=<playlistId>`) would carry the
 * same listening list the request URL does, so Sentry drops the header too.
 * Studio v3 adds the private preview page and the press kit pages, which name
 * a release or an artist a member was shown. Liked songs adds `/studio/liked`,
 * the member's own liked tracks. Studio listening adds `/studio/listening`,
 * the member's own history.
 */
const STUDIO_LISTENING_PAGE_PATTERN =
  /(?:^|\/)studio\/(?:collection|album|track|artist|set|live|search|library|browse|scene|preview|press|liked|listening)(?:\/|$)/i;

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
