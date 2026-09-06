import type { Event } from './entities/event.entity';

/**
 * Whether a gathering is over.
 *
 * `endAt` is optional — plenty of hosts state only a start time — so the
 * fallback matters: a gathering with no stated end is treated as over once it
 * has started. That is deliberately the strict reading. The alternative (open
 * until some invented default duration elapses) would mean the server picking
 * a length for someone else's evening, and the only thing this predicate gates
 * is whether a NEW commitment can still be made. Someone who wants a seat at a
 * supper club that began an hour ago is not being denied anything real.
 *
 * Used by `RsvpService.rsvp` (PRD-183) and mirrored on the frontend by
 * `gatheringHasEnded` in `queerpulse/src/features/gatherings/data.ts`, which
 * renders the matching "this gathering has ended" state so the button is gone
 * before it can be pressed. Both sides must agree, or a member sees a live
 * button that answers 400.
 */
export function hasEnded(
  event: Pick<Event, 'startAt' | 'endAt'>,
  now: Date = new Date(),
): boolean {
  const finishesAt = event.endAt ?? event.startAt;
  return finishesAt.getTime() <= now.getTime();
}
