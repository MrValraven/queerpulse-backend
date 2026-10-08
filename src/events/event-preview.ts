import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';

/**
 * The guest perspectives an organiser can preview their own gathering as
 * (`GET /events/:slug?viewAs=` and the lineup read beside it).
 */
export const GUEST_PREVIEW_ROLES = ['member', 'going', 'waitlisted'] as const;
export type GuestPreviewRole = (typeof GUEST_PREVIEW_ROLES)[number];

/**
 * The stand-in viewer a guest preview is built for: the nil UUID, which
 * matches no account. No connection, block or "this is my own RSVP" rule
 * ever admits it, so the preview shows exactly what a member the attendees
 * are not connected to would see.
 */
export const PREVIEW_STAND_IN_VIEWER_ID =
  '00000000-0000-0000-0000-000000000000';

/** What a preview replaces in `EventsService.buildDetail`. */
export interface DetailPreview {
  rsvpStatus: RsvpStatus | null;
  /**
   * Every real viewer of a community-only gathering is on the hosting
   * community's roster, so the stand-in counts as on it too and reads the
   * hosting community the way they do.
   */
  isStandInOnRoster: boolean;
}

export function previewRsvpStatus(role: GuestPreviewRole): RsvpStatus | null {
  if (role === 'going') return RsvpStatus.Going;
  if (role === 'waitlisted') return RsvpStatus.Waitlisted;
  return null;
}

/**
 * The pretend RSVP a preview reads in place of the viewer's own row. A
 * waitlisted preview sits where a new waitlister would land: one behind
 * everyone already waiting.
 */
export function previewRsvpRow(
  status: RsvpStatus | null,
  waitlistCount: number,
): EventRsvp | null {
  if (status === null) return null;
  return Object.assign(new EventRsvp(), {
    status,
    waitlistPosition:
      status === RsvpStatus.Waitlisted ? waitlistCount + 1 : null,
  });
}
