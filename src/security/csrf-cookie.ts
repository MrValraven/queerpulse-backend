// The CSRF double-submit cookie name. In production it carries the `__Host-`
// prefix, which the browser enforces as: Secure, Path=/, and NO Domain
// attribute — i.e. strictly host-only. That is precisely what blocks CSRF
// cookie fixation: a sibling/compromised subdomain physically cannot write a
// `__Host-` cookie that the browser will send up to the apex, so it can never
// plant a csrf_token value it also knows and use it to satisfy the double-submit
// check. (Cross-site forgery is already stopped upstream by our SameSite=Lax
// session cookies; this closes the residual same-site fixation vector.)
//
// The prefix REQUIRES Secure, which a plain-HTTP local dev server can't set, so
// outside production we fall back to the bare name. `nodeEnv` is the single
// switch; the controller (which sets the cookie) and the guard (which reads it)
// derive the name from it identically so they never disagree.
export const CSRF_COOKIE_HOST = '__Host-csrf_token';
export const CSRF_COOKIE_LEGACY = 'csrf_token';

/** The active CSRF cookie name for this environment. */
export function csrfCookieName(nodeEnv: string | undefined): string {
  return nodeEnv === 'production' ? CSRF_COOKIE_HOST : CSRF_COOKIE_LEGACY;
}
