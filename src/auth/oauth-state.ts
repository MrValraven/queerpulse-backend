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
 *
 * `ageAttested` is the one field that cannot be independently re-validated: it
 * is a *self-declaration*, so whatever arrives here is what we record. That is
 * acceptable precisely because the thing it mirrors — ticking a checkbox — is
 * equally self-declared: forging the state param buys an attacker exactly what
 * clicking the box buys them, and nothing more. What it is NOT is proof the
 * member saw the checkbox, since a third party can hand someone a crafted
 * `/auth/google?ageAttested=1` link. If that distinction ever needs to hold up
 * (a regulator asking to see the affirmative act), replace this with a
 * server-side attestation row keyed to the `nonce` and written *before* the
 * redirect, so the record is minted by us rather than echoed back to us.
 */
export interface OAuthState {
  /** Invite code for invite-gated signup (returning members don't need one). */
  invite?: string;
  /** Internal app path to land on after login, e.g. `/feed`. */
  redirect?: string;
  /**
   * The 18+ self-attestation, ticked on the invite landing page before the
   * "Register with Google" button unlocks. Required to create a NEW account
   * (Terms §eligibility); returning members already have theirs on file.
   */
  ageAttested?: boolean;
  /** Which Terms revision the member attested against, for the audit trail. */
  termsVersion?: string;
  /**
   * Anti-CSRF / session-fixation nonce. Minted when the flow starts, stored in a
   * short-lived httpOnly `oauth_state` cookie, and echoed here inside `state`.
   * The callback rejects unless the two match — this is what actually makes the
   * `state` value trustworthy (the redirect/invite are still independently
   * validated). Unlike invite/redirect it is NOT user-supplied, so tampering
   * with it just fails the check.
   */
  nonce?: string;
  /**
   * Marks this round trip as a step-up RE-authentication (see
   * `AccountService`'s reauth token, minted only via this flow) rather than an
   * ordinary sign-in. `GoogleAuthGuard` sets `prompt=login` on the outbound
   * leg so returning here proves the browser could complete a fresh Google
   * login right now — not just that it still holds a valid session cookie.
   * The callback branches on this BEFORE `validateOrCreateGoogleUser`: it
   * never creates/updates an account or touches session cookies, it only
   * verifies the returned Google account matches the CURRENTLY signed-in
   * member and mints a reauth token. Tampering buys an attacker nothing: the
   * callback independently re-checks the caller's own access-token cookie
   * against the Google account that just authenticated, so a forged
   * `reauth: true` with no real re-login still fails that comparison.
   */
  reauth?: boolean;
}

/**
 * The only shape a `termsVersion` may take: the value is copied from a query
 * param the caller controls and written straight into `users.terms_version`,
 * declared `varchar(32)`. A longer or stranger value made the INSERT fail with
 * SQLSTATE 22001 AFTER Google consent — i.e. a crafted invite link
 * (`/auth/google?invite=…&ageAttested=1&termsVersion=<40 chars>`) turned
 * someone else's signup into an unrecoverable 500. Anything that does not
 * match is dropped (recorded as NULL), which is the same state every account
 * predating the attestation already has.
 */
const TERMS_VERSION_PATTERN = /^[0-9A-Za-z.-]{1,32}$/;

/** The `termsVersion` if it is storable, otherwise `undefined`. */
export function sanitizeTermsVersion(value: unknown): string | undefined {
  return typeof value === 'string' && TERMS_VERSION_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Encode a state payload into a single base64url string, or `undefined` when
 * there is nothing to carry (so the caller can omit `state` entirely).
 */
export function encodeOAuthState(state: OAuthState): string | undefined {
  const payload: OAuthState = {};
  if (state.invite) payload.invite = state.invite;
  if (state.redirect) payload.redirect = state.redirect;
  if (state.nonce) payload.nonce = state.nonce;
  if (state.ageAttested) payload.ageAttested = true;
  const termsVersion = sanitizeTermsVersion(state.termsVersion);
  if (termsVersion) payload.termsVersion = termsVersion;
  if (state.reauth) payload.reauth = true;
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
      if (typeof obj.nonce === 'string') out.nonce = obj.nonce;
      // Strictly `=== true`: a truthy string like "false" must not attest.
      if (obj.ageAttested === true) out.ageAttested = true;
      // Bounded on the way back in too: `state` round-trips through the
      // browser, so the encode-side clamp above is not a guarantee.
      const decodedTermsVersion = sanitizeTermsVersion(obj.termsVersion);
      if (decodedTermsVersion) {
        out.termsVersion = decodedTermsVersion;
      }
      // Strictly `=== true`, same reasoning as `ageAttested` above.
      if (obj.reauth === true) out.reauth = true;
      return out;
    }
  } catch {
    // Not our encoded format — fall through to legacy handling below.
  }
  // Legacy: `state` was the raw invite code.
  return { invite: raw };
}
