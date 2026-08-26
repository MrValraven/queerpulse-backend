/**
 * Domain events emitted by `VolunteeringService`. Same fire-and-forget
 * `EventEmitter2` bus and same post-commit emit discipline as
 * `event.events.ts` / `connection.events.ts`: an emit inside a transaction
 * would survive a rollback, so the emit happens once the write is committed.
 */

export const VOLUNTEER_SESSION_COMPLETED = 'volunteering.session_completed';

/**
 * A volunteer session was confirmed by the opportunity's poster (or by an
 * organiser of the community the opportunity is attributed to). Fired exactly
 * once per signup: the claiming UPDATE behind it only moves a row whose
 * `completed_at` is still NULL, so a repeated confirmation emits nothing and
 * nothing double-counts downstream.
 *
 * Fired for a no-show too (`attended: false`, `hoursContributed: 0`), because
 * "we recorded that this did not happen" is a real state change the desk
 * should be able to react to. Consumers that reward the work must gate on
 * `attended` themselves. `RecognitionListener` does not need to: its recompute
 * re-reads the live count of ATTENDED sessions, so a no-show recompute is a
 * no-op by construction.
 */
export interface VolunteerSessionCompletedEvent {
  signupId: string;
  opportunityId: string;
  /** Carried so a consumer can deep-link without a second query, mirroring
   *  `EventRsvpedEvent.eventSlug`. */
  opportunitySlug: string;
  /** The member who volunteered: the person whose recognition changes. */
  volunteerId: string;
  /** Who attested it: the poster, or a community organiser standing in. */
  confirmedById: string;
  attended: boolean;
  hoursContributed: number;
  completedAt: string;
}
