/**
 * OAuth `state` codec.
 *
 * The Google consent hop is a cross-site redirect, so anything we need on the
 * way back must travel *with* the request, not in a session cookie that may not
 * survive the round-trip. We pack everything into the standard OAuth `state`
 * parameter, base64url-encoded so it is a single opaque query value.
 *
 * `state` historically carried the raw invite code as a bare string. To stay
 * backwards compatible, `decodeOAuthState` falls back to treating an
 * un-decodable value as a legacy `{ invite }` payload.
 *
 * Integrity note: the redirect is *validated structurally* on the way out (see
 * safe-redirect.ts) and the invite is validated against the DB, so neither is
 * trusted just because it round-tripped through `state`. Tampering buys an
 * attacker nothing — a bad redirect falls back to the default landing page and
 * a bad invite is rejected.
 */
export interface OAuthState {
  /** Invite code for invite-gated signup (returning members don't need one). */
  invite?: string;
  /** Internal app path to land on after login, e.g. `/feed`. */
  redirect?: string;
}

/**
 * Encode a state payload into a single base64url string, or `undefined` when
 * there is nothing to carry (so the caller can omit `state` entirely).
 */
export function encodeOAuthState(state: OAuthState): string | undefined {
  const payload: OAuthState = {};
  if (state.invite) payload.invite = state.invite;
  if (state.redirect) payload.redirect = state.redirect;
  if (Object.keys(payload).length === 0) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode a `state` value back into its payload. Tolerant of the legacy bare
 * invite-code format and of garbage — never throws, returns `{}` on absence.
 */
export function decodeOAuthState(raw: string | undefined | null): OAuthState {
  if (!raw) {
    return {};
  }
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const out: OAuthState = {};
      if (typeof obj.invite === 'string') out.invite = obj.invite;
      if (typeof obj.redirect === 'string') out.redirect = obj.redirect;
      return out;
    }
  } catch {
    // Not our encoded format — fall through to legacy handling below.
  }
  // Legacy: `state` was the raw invite code.
  return { invite: raw };
}
