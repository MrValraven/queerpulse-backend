import { EventVisibility } from './entities/event.entity';

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
  // Carried so the WaitlistPromoted notification can deep-link straight to the
  // event page / MyEvents card (the client keys events by slug, not uuid).
  eventSlug: string;
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
  // Carried so the profiles `ActivityListener` can (a) title the activity row
  // with the event name and (b) gate on visibility — only a `public` event's
  // RSVP is recorded as public activity. Additive: the notifications listener
  // ignores both.
  eventTitle: string;
  eventVisibility: EventVisibility;
}

export const EVENT_COHOST_INVITED = 'event.cohost_invited';

/**
 * A host/co-host sent a real cohost invite (SDD 2026-08-18 "cohost invite
 * flow"). `eventSlug` rides along so the notification listener can build a
 * deep link without a second query; mirrors `EventRsvpedEvent`.
 */
export interface EventCohostInvitedEvent {
  eventId: string;
  eventSlug: string;
  inviteId: string;
  inviterId: string;
  inviteeId: string;
}

export const EVENT_LINEUP_INVITED = 'event.lineup_invited';

/** An organizer invited a member onto an event's lineup (2026-10-06). */
export interface EventLineupInvitedEvent {
  entryId: string;
  eventId: string;
  eventSlug: string;
  inviterId: string;
  inviteeId: string;
  role: string;
}

export const EVENT_LINEUP_ANSWERED = 'event.lineup_answered';

/**
 * A member accepted or declined a lineup invite. `recipientId` is the
 * organizer who invited them, or the host when that account is gone.
 */
export interface EventLineupAnsweredEvent {
  entryId: string;
  eventId: string;
  eventSlug: string;
  performerId: string;
  recipientId: string;
  role: string;
  outcome: 'accepted' | 'declined';
}

export const EVENT_DELETING = 'event.deleting';

/**
 * A gathering is about to be hard-deleted. Emitted with `emitAsync` BEFORE the
 * row goes, and the delete waits for every listener: the cascade removes rows
 * other modules own (Go together's config, groups and entries), so anything
 * that must be wound down while those rows still exist happens here.
 * A listener that throws aborts the delete. Listeners register with
 * `suppressErrors: false` so the failure reaches the emitter.
 */
export interface EventDeletingEvent {
  eventId: string;
}

export const EVENT_DOOR_CHANGED = 'event.door.changed';

/**
 * A check-in or an undo changed state at a gathering's door (an idempotent
 * repeat does not fire this). `organizerUserIds` is the host plus the
 * co-hosts, the same people the check-in routes admit; the chat relay turns
 * this into the `gathering:checkin` frame for their `user:` rooms only.
 */
export interface EventDoorChangedEvent {
  eventSlug: string;
  memberSlug: string;
  change: 'checked_in' | 'undone';
  organizerUserIds: string[];
}

/**
 * The `gathering:checkin` socket frame. It goes to each organiser's own
 * `user:<userId>` room and to no other: who went is sensitive, so the frame
 * names no guest beyond their slug and carries no names or arrival stamps.
 * A door device refetches its roster and groups on it.
 */
export const GATHERING_CHECKIN_FRAME = 'gathering:checkin';

/** Payload of {@link GATHERING_CHECKIN_FRAME}. */
export interface GatheringCheckInFrame {
  eventSlug: string;
  memberSlug: string;
  change: 'checked_in' | 'undone';
}
