/**
 * The one thing the auth module says out loud about an ordinary, uneventful
 * session: it was just refreshed.
 *
 * WHY AN EVENT RATHER THAN A DIRECT CALL. Announcing this the way
 * `security.events.ts` announces a new sign-in keeps `AuthModule` free of an
 * import edge to `ProfilesModule` (which pulls `UsersModule`, `VouchModule`,
 * `ConnectionsModule` and `SocialModule` behind it, into a module half the
 * platform already imports). Constants and interfaces only, no Nest
 * decorators, importable from either side.
 *
 * WHAT THE CONSUMER MAY DO WITH IT. Exactly one thing today:
 * `LastActiveListener` coarsens `at` to its month and, at most once a day per
 * member, stores that month. This event is emitted often and carries a precise
 * instant, so treat it as the short-lived in-memory value it is. Persisting
 * `at` anywhere, in any shape finer than a month, is the thing the coarse
 * activity signal exists to prevent. See `profiles/last-active.ts`.
 *
 * NOT AN ANALYTICS HOOK. There is no counter, no funnel and no session log
 * behind this, and none may be added: QueerPulse does not track member
 * behaviour.
 */

/** A refresh token was successfully rotated for a live session. */
export const SESSION_REFRESHED = 'auth.session_refreshed';

export interface SessionRefreshedEvent {
  /** The member whose session it is. */
  userId: string;
  /**
   * When the refresh happened. Consumers coarsen this immediately; it exists
   * as a parameter rather than a `new Date()` inside the consumer so the
   * month boundary is testable.
   */
  at: Date;
}
