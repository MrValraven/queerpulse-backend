/**
 * Single source of truth for parsing `FRONTEND_URL`.
 *
 * `FRONTEND_URL` is a **comma-separated allowlist of exact origins** (scheme +
 * host [+ port], no path, no trailing slash) — e.g.
 * `https://queerpulse.com,https://www.queerpulse.com`. A single origin is the
 * common case and keeps the historical behaviour unchanged.
 *
 * Both the HTTP CORS config (`main.ts`) and the socket.io gateway CORS callback
 * (`chat/chat.gateway.ts`) parse the variable through here so the two can never
 * drift — a browser that is allowed to call the API is allowed to open a socket
 * to it, by construction.
 */

/** Vite's dev-server origin; the default when `FRONTEND_URL` is unset. */
export const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:5173';

/**
 * Parse the raw `FRONTEND_URL` value into a de-duplicated origin allowlist.
 *
 * Empty entries are dropped and trailing slashes are stripped — an `Origin`
 * header never carries one, so `https://queerpulse.com/` would otherwise match
 * nothing and fail CORS silently. Never returns an empty array: with nothing
 * usable configured it falls back to {@link DEFAULT_FRONTEND_ORIGIN}, matching
 * the previous `?? 'http://localhost:5173'` behaviour.
 */
export function parseFrontendOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter((entry) => entry.length > 0);
  const deduped = Array.from(new Set(entries));
  return deduped.length > 0 ? deduped : [DEFAULT_FRONTEND_ORIGIN];
}

/**
 * Read + parse `process.env.FRONTEND_URL` at call time.
 *
 * Deliberately reads `process.env` rather than taking a ConfigService: the chat
 * gateway's CORS callback runs before/outside DI (see the note at its call
 * site). Callers that already have ConfigService should read
 * `app.frontendOrigins` instead.
 */
export function resolveFrontendOrigins(): string[] {
  return parseFrontendOrigins(process.env.FRONTEND_URL);
}

/**
 * Return the entries of a raw `FRONTEND_URL` that are not exact origins, for
 * boot-time validation. An entry is exact when it round-trips through the URL
 * parser unchanged (`new URL(x).origin === x`), which rejects paths, queries,
 * fragments, credentials and bare hostnames.
 */
export function invalidFrontendOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter((entry) => entry.length > 0 && !isExactOrigin(entry));
}

function normalizeOrigin(entry: string): string {
  return entry.trim().replace(/\/+$/, '');
}

function isExactOrigin(entry: string): boolean {
  try {
    return new URL(entry).origin === entry;
  } catch {
    return false;
  }
}
