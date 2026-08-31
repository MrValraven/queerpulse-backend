/**
 * Query-string redaction for anything that logs or reports a URL.
 *
 * WHY THIS EXISTS: several credentials on this platform travel as query
 * parameters, because the browser has to carry them across a navigation where
 * no request body and no header exist. The worst of them is `?invite=<code>`
 * on `GET /auth/google` (read in `auth/guards/google-auth.guard.ts`).
 * `invites.email` is nullable, so a personal invite is frequently a bare
 * bearer credential: whoever holds the code can create an account on an
 * invite-only platform. Every sign-in through an invite link wrote that code
 * verbatim into the request log, and into Sentry as request context, so log
 * access or Sentry access was account-creation access. The OAuth authorization
 * `?code=` and the OAuth `?state=` (which itself carries the invite code, see
 * `auth/oauth-state.ts`) are exactly the same shape of problem, as are the
 * opaque `?token=` values behind the public newsletter-confirm and
 * join-request-status pages.
 *
 * WHY REDACT NARROWLY rather than dropping the query wholesale: the reason we
 * log the URL at all is to be able to read an incident back afterwards, and a
 * path with no query tells you almost nothing about a list endpoint, a
 * paginated fetch or a search. So the parameter NAMES and every value outside
 * the sensitive set survive untouched, and only the sensitive values are
 * replaced. A reader still sees that an invite was present and which one it
 * was NOT.
 *
 * WHY A DEPENDENCY-FREE MODULE: `instrument.ts` imports this, and that file
 * runs before `NestFactory.create`, ahead of the whole Nest container. This
 * module therefore imports nothing at all. Keep it that way: an import here
 * that reaches the app module would load `http`/`express`/`pg` before
 * `Sentry.init` has patched them, silently costing every captured error its
 * request context.
 */

/** What a redacted value is replaced with. Fixed, so it is greppable in logs. */
export const REDACTED_QUERY_VALUE = '[redacted]';

/**
 * Parameter names whose VALUES never reach a log line or an error report.
 * Matched case-insensitively (see {@link redactSensitiveQueryParameters}),
 * so entries here are written in lower case.
 *
 * The set is drawn from what actually travels in a query string in this
 * codebase, plus a small margin for values we hand to or receive from other
 * services:
 *
 *   invite         the invite code on `GET /auth/google`, a bearer credential
 *                  that creates an account (`google-auth.guard.ts`).
 *   state          the OAuth state on `/auth/google/callback`. It carries both
 *                  the login-CSRF nonce and the invite code above.
 *   code           Google's authorization code on the same callback. Single
 *                  use and short lived, and still exchangeable for a session
 *                  by whoever reads the log first.
 *   token          the newsletter confirm/unsubscribe token
 *                  (`newsletter.controller.ts`) and the applicant's
 *                  `GET /join-requests/status?token=` credential. Also the
 *                  Mux playback tokens we build into stream URLs.
 *   access_token / refresh_token / id_token / secret / password / api_key /
 *   apikey         not currently emitted by any route here. They cost nothing
 *                  to list and cover an OAuth or webhook URL from a provider
 *                  that ends up in an error report.
 *   key            the storage object key on `GET /admin/media/head`. Not a
 *                  credential by itself, and still a direct pointer at one
 *                  member's private upload.
 *   signature / sig
 *   x-amz-signature / x-amz-credential / x-amz-security-token
 *                  presigned-storage material. Our presigned URLs are minted
 *                  for the browser rather than requested from us, so they do
 *                  not appear in `req.url`; they DO appear inside AWS SDK
 *                  errors that Sentry captures, where the signature is a live
 *                  write capability against the bucket until it expires.
 *   email          the invitee-email filter on the admin invite console
 *                  (`list-admin-invites.query.ts`). Not a credential, and on
 *                  an LGBTQ+ platform an email address in a log store is
 *                  exactly the identifying data the retention rules exist to
 *                  keep out of one.
 *
 * Deliberately NOT here: `redirect`, `q`, `search`, `page`, `lang` and the
 * other filter parameters. They are the debugging value of logging a URL.
 */
export const SENSITIVE_QUERY_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  'invite',
  'state',
  'code',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'key',
  'signature',
  'sig',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'email',
]);

/**
 * Decodes one raw parameter name for comparison against the sensitive set.
 *
 * `decodeURIComponent` throws a `URIError` on a malformed escape such as
 * `%zz`, and this runs inside a log serializer, where throwing would take down
 * the request it was only supposed to describe. A name we cannot decode is
 * compared as-is, which is the conservative outcome: an undecodable name still
 * gets matched if it was already spelled in plain text.
 */
function decodeParameterName(rawName: string): string {
  try {
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
}

/**
 * Whether a query parameter's value must be redacted. Exported for callers that
 * already hold the query as parsed name/value pairs rather than as a string,
 * which is one of the three shapes a Sentry event can keep it in.
 */
export function isSensitiveQueryParameterName(rawName: string): boolean {
  return SENSITIVE_QUERY_PARAMETER_NAMES.has(
    decodeParameterName(rawName).toLowerCase(),
  );
}

/**
 * Returns `url` with the values of {@link SENSITIVE_QUERY_PARAMETER_NAMES}
 * replaced by {@link REDACTED_QUERY_VALUE}, leaving the parameter names, the
 * path and every other parameter exactly as they were.
 *
 * Accepts a path-only request target (`/auth/google?invite=abc`, which is what
 * Node hands us as `req.url`) as readily as an absolute URL, and never throws.
 *
 * WHY IT SPLITS THE STRING instead of round-tripping through `new URL(url,
 * dummyBase)`: rebuilding from a parsed `URL` normalizes the whole target.
 * Dot segments collapse, percent-escapes are rewritten and `a b` comes back as
 * `a+b`, so the logged line would stop being the request that actually
 * arrived. That matters most in the case you most want the log for, namely
 * someone probing with a deliberately odd path. Splitting on `&` and the first
 * `=` of each pair leaves every byte outside a redacted value untouched, and
 * has no failure mode to guard against.
 */
export function redactSensitiveQueryParameters(url: string): string;
export function redactSensitiveQueryParameters(
  url: string | undefined,
): string | undefined;
export function redactSensitiveQueryParameters(
  url: string | undefined,
): string | undefined {
  if (typeof url !== 'string') {
    return url;
  }

  const queryStartIndex = url.indexOf('?');
  if (queryStartIndex === -1) {
    return url;
  }

  const beforeQuery = url.slice(0, queryStartIndex + 1);
  const afterQueryStart = url.slice(queryStartIndex + 1);

  // A fragment is never part of an HTTP request target, so `req.url` cannot
  // carry one. Sentry's `event.request.url` can, since it is assembled from a
  // full URL, and a `#` there would otherwise be swallowed into the last
  // parameter's value and re-emitted as part of it.
  const fragmentStartIndex = afterQueryStart.indexOf('#');
  const query =
    fragmentStartIndex === -1
      ? afterQueryStart
      : afterQueryStart.slice(0, fragmentStartIndex);
  const fragment =
    fragmentStartIndex === -1 ? '' : afterQueryStart.slice(fragmentStartIndex);

  const redactedQuery = query
    .split('&')
    .map((pair) => {
      if (pair === '') {
        return pair;
      }
      const separatorIndex = pair.indexOf('=');
      const rawName =
        separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
      if (!isSensitiveQueryParameterName(rawName)) {
        return pair;
      }
      // A valueless sensitive parameter (`?token`) still comes back with the
      // placeholder rather than as a bare name: the reader learns the same
      // thing either way, and the output stays uniform for anyone grepping.
      return `${rawName}=${REDACTED_QUERY_VALUE}`;
    })
    .join('&');

  return `${beforeQuery}${redactedQuery}${fragment}`;
}

/**
 * The same redaction applied to a bare query string with no leading `?`, which
 * is the shape Sentry keeps in `event.request.query_string`.
 */
export function redactSensitiveQueryString(query: string): string {
  const redacted = redactSensitiveQueryParameters(`?${query}`);
  return redacted.slice(1);
}
