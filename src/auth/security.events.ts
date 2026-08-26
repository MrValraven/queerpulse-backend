/**
 * Account-security events the auth module announces about a member's own
 * account, consumed by `NotificationsListener`.
 *
 * WHY AN EVENT RATHER THAN A DIRECT CALL: `AuthService` cannot inject
 * `NotificationsService` without pulling `NotificationsModule` (and its
 * `SocialModule` graph) into `AuthModule`, which half the platform already
 * imports. Every other cross-module notification in this codebase is wired the
 * same way, so this file is the auth module's counterpart to
 * `connections/connection.events.ts` and friends: constants and interfaces
 * only, no Nest decorators, importable from either side without a module edge.
 */

/**
 * A refresh-token FAMILY was created for a device this member has not signed in
 * from before (see `AuthService.issueTokens`).
 *
 * Fired at most once per sign-in, and never for a member's FIRST-EVER session:
 * telling somebody that the browser they are currently looking at just signed
 * in is noise, and noise is how a security alert gets ignored.
 */
export const SECURITY_NEW_SIGN_IN = 'security.new_sign_in';

export interface SecurityNewSignInEvent {
  /** The account that was signed in to. Always the notification's recipient. */
  userId: string;
  /**
   * The coarse device name (`deviceLabelFromUserAgent`), e.g. "Chrome on
   * macOS". Deliberately not the raw User-Agent: this string is rendered into
   * a notification a member reads at a glance, and it must never be precise
   * enough to fingerprint a machine.
   */
  deviceLabel: string;
  /** When the session began — `refresh_tokens.session_started_at`. */
  signedInAt: Date;
  /**
   * The new session's family id, so the notification can be traced back to the
   * exact row on `/account/sessions` if anyone ever needs to.
   */
  familyId: string;
}
