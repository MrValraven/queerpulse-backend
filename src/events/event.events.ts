export const EVENT_INVITED = 'event.invited';
export const EVENT_WAITLIST_PROMOTED = 'event.waitlist_promoted';
export const EVENT_RSVPED = 'event.rsvped';

export interface EventInvitedEvent {
  eventId: string;
  inviteId: string;
  inviterId: string;
  inviteeId: string;
}

export interface EventWaitlistPromotedEvent {
  eventId: string;
  userId: string;
}

/**
 * A member placed a *first* RSVP (going/maybe) on an event — fired once per
 * new attendee so the host is notified, never on a re-RSVP or a status toggle
 * of an existing row. Carries the slug so the notification can deep-link
 * straight to the event page.
 */
export interface EventRsvpedEvent {
  eventId: string;
  eventSlug: string;
  hostId: string;
  rsvperId: string;
}
