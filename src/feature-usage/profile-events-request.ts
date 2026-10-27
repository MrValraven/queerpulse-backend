/**
 * Recognises `GET /profiles/:slug/events`, the Events section of a member
 * profile, so feature-usage reach leaves it out. The route carries
 * `@Feature('events')` for the launch gate, yet it answers every profile
 * view: counting it would add one events request per profile opened and
 * read as members reaching for events.
 */

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

const PROFILE_EVENTS_PATH = /^(?:\/v\d+)?\/profiles\/[^/]+\/events\/?$/i;

export function isProfileEventsRequest(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    return PROFILE_EVENTS_PATH.test(new URL(url, PLACEHOLDER_ORIGIN).pathname);
  } catch {
    return false;
  }
}
