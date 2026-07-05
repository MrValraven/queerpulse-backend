export type OAuthProfileErrorReason = 'no_email' | 'email_unverified';

/**
 * Thrown from `GoogleStrategy.validate` when Google returns a profile we refuse
 * to sign in — no email on the account, or an unverified email. The
 * `GoogleAuthGuard` maps `reason` onto a frontend `?error=<reason>` redirect via
 * `OAuthCallbackError` instead of surfacing a raw 500.
 */
export class OAuthProfileError extends Error {
  constructor(public readonly reason: OAuthProfileErrorReason) {
    super(reason);
    this.name = 'OAuthProfileError';
  }
}
