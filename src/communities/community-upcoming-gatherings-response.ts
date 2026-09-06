/**
 * `GET /communities/:slug/upcoming-gatherings` — PRD-145.
 *
 * WHY THIS TYPE EXISTS AT ALL, rather than a flag on the pulse response.
 * `GET /communities/:slug/pulse` is roster-only, and its
 * `CommunityPulseResponse` carries three arms: gatherings, recent discussion
 * threads, and open volunteer opportunities. Two of those three are
 * member-only material. Relaxing the pulse's membership gate and blanking the
 * other two arms would make a non-member's safety depend on a caller passing
 * the right flag, and one future `if` written the wrong way round would hand a
 * stranger a community's discussion titles. A separate response type with only
 * gatherings on it makes that leak structurally impossible: there is no field
 * here for a post to travel in.
 *
 * ================= DO NOT WIDEN THIS TYPE =================
 * Every field here is served to an authenticated member who is NOT on this
 * community's roster. The list is closed:
 *
 *   slug, title, startAt, endAt, isOnline, venue, neighbourhood, eventType,
 *   cost, coverImageUrl, goingCount
 *
 * It must NEVER carry:
 *   - the roster, or any part of it, in any arm.
 *   - any community post, reply, announcement or discussion thread.
 *   - any attendee's identity. `goingCount` is a number, it stays a number,
 *     and it is null whenever the host turned `showAttendeeCount` off.
 *   - the gathering's street `address` or `arrivalNotes`. Those are withheld
 *     from everyone without a confirmed 'going' RSVP (see `Event.address`),
 *     and a prospective member has none by definition.
 * ==========================================================
 */
export interface CommunityUpcomingGathering {
  slug: string;
  title: string;
  startAt: Date;
  endAt: Date | null;
  isOnline: boolean;
  /** The free-text venue name. Never the street address. */
  venue: string | null;
  neighbourhood: string | null;
  eventType: string | null;
  /** Display-only free text ("pay what you can at the door"). */
  cost: string | null;
  /** Resolved through `toImageUrl`, or null when unset. */
  coverImageUrl: string | null;
  /**
   * How many members hold a 'going' RSVP, or `null` when the host turned
   * `Event.showAttendeeCount` off. The host's toggle is honoured here rather
   * than widened: a prospective member sees exactly what the host chose to
   * publish.
   */
  goingCount: number | null;
}

/**
 * One bounded page of a community's upcoming gatherings, soonest first.
 * `hasMore` says whether another page exists, so the Events tab can offer
 * "show more" without a separate count query.
 */
export interface CommunityUpcomingGatheringsResponse {
  items: CommunityUpcomingGathering[];
  page: number;
  hasMore: boolean;
}
