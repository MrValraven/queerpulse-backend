/**
 * Copy shown to a member turned away by the platform lockdown when the admin
 * has not written a message of their own.
 *
 * Shared by the two enforcement points — `PlatformLockdownGuard` (HTTP 503) and
 * `ChatGateway`'s handshake check (WS `PLATFORM_LOCKED`) — so the two cannot
 * drift into telling the same member two different things on two transports.
 */
export const DEFAULT_LOCKDOWN_MESSAGE =
  'QueerPulse is temporarily unavailable. Please check back soon.';
