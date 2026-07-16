/**
 * Raised inside `GoogleAuthGuard.handleRequest` when the OAuth callback cannot
 * produce a usable profile — the user denied consent (`access_denied`), Google
 * returned an error, or the profile failed our checks (`no_email`,
 * `email_unverified`). `OAuthCallbackFilter` catches it and redirects the
 * browser to the SPA sign-in page with `?error=<code>` rather than emitting a
 * bare 401/500 JSON page to a human sitting on a redirect.
 */
export class OAuthCallbackError extends Error {
  constructor(public readonly code: string) {
    super(`oauth_callback:${code}`);
    this.name = 'OAuthCallbackError';
  }
}
