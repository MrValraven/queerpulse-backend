/**
 * Post-login redirect safety.
 *
 * The frontend may send `?redirect=<url-encoded internal path>` when starting
 * Google sign-in (e.g. `/feed`). We must never reflect an attacker-controlled
 * value into a redirect — that is a textbook open-redirect / phishing vector.
 *
 * `safeRedirectPath` is the security gate: it accepts ONLY same-origin internal
 * paths and rejects everything else. `resolvePostLoginRedirect` turns a (maybe
 * unsafe, maybe absent) value into a concrete URL, always falling back to the
 * frontend's default landing page.
 */

// Matches any ASCII control char (0x00-0x1F), space (0x20), or DEL (0x7F).
// Newlines/CR in a redirect target enable header-injection style tricks.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\x00-\x20\x7f]/;

/**
 * Returns the value unchanged if it is a safe internal path, otherwise `null`.
 *
 * Accepts only values that:
 *  - start with a single `/` (rejects `//`, `/\`, protocol-relative URLs),
 *  - contain no `://` (rejects embedded schemes),
 *  - contain no backslashes (browsers normalise `\` to `/`, enabling `/\evil`),
 *  - contain no control characters or whitespace.
 */
export function safeRedirectPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  // Must be an absolute path on this site...
  if (value[0] !== '/') {
    return null;
  }
  // ...but NOT protocol-relative (`//host`) or a backslash trick (`/\host`).
  if (value[1] === '/' || value[1] === '\\') {
    return null;
  }
  // Any backslash anywhere is suspicious — browsers treat `\` as `/`.
  if (value.includes('\\')) {
    return null;
  }
  // No embedded scheme (`http://`, `javascript:`-via-`//`, etc.).
  if (value.includes('://')) {
    return null;
  }
  // Reject control chars, space and DEL.
  if (UNSAFE_CHARS.test(value)) {
    return null;
  }
  return value;
}

/**
 * The SPA's sign-in route. Must stay in sync with `routes.signIn` in the
 * frontend's `src/app/routeMap.ts` — a stale value strands rejected users on the
 * SPA's 404 page instead of showing them why sign-in failed.
 */
const SIGN_IN_PATH = '/auth/sign-in';

/**
 * Absolute URL of the sign-in page carrying a machine-readable failure code.
 *
 * The Google callback is a top-level browser navigation, so every failure path
 * (guard-level OAuth errors, a bad `state` nonce, a rejected signup) has to come
 * back as a redirect a human can read rather than a JSON error body. The SPA
 * maps `?error=<code>` to a user-facing notice.
 */
export function signInErrorUrl(frontendUrl: string, code: string): string {
  const target = new URL(SIGN_IN_PATH, frontendUrl);
  target.searchParams.set('error', code);
  return target.toString();
}

/**
 * Resolve the absolute URL to send the browser to after a successful login.
 *
 * If `redirect` is a safe internal path it is appended to `frontendUrl`;
 * otherwise (absent or invalid) the bare `frontendUrl` (default landing) is
 * returned. The resolved URL is re-checked to be same-origin as a final guard.
 */
export function resolvePostLoginRedirect(
  redirect: unknown,
  frontendUrl: string,
): string {
  const safe = safeRedirectPath(redirect);
  if (!safe) {
    return frontendUrl;
  }
  try {
    const base = new URL(frontendUrl);
    const target = new URL(safe, base);
    // Defense in depth: the structural checks already guarantee this, but never
    // emit a cross-origin redirect.
    if (target.origin !== base.origin) {
      return frontendUrl;
    }
    return target.toString();
  } catch {
    return frontendUrl;
  }
}
