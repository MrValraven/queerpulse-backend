/**
 * Cross-module hook so enabling the lockdown can reach transports the HTTP
 * guard cannot.
 *
 * `PlatformLockdownGuard` takes effect on the very next HTTP request, but a
 * WebSocket is only checked at its handshake — a socket opened before the flip
 * would otherwise keep sending and receiving for the remaining life of its
 * 15-minute access token. `PlatformSettingsService.update()` EMITS this event
 * on a false -> true transition of `lockdownEnabled` (not on every save), and
 * `ChatGateway` consumes it by disconnecting live sockets.
 *
 * Modelled on {@link USER_SESSION_REVOKED} in `chat/session.events.ts`: a
 * constant naming the topic plus a payload interface, emitted with `satisfies`.
 */
export const PLATFORM_LOCKDOWN_ENABLED = 'platform.lockdown.enabled';

export interface PlatformLockdownEnabledEvent {
  /** The admin who turned the lockdown on — for audit correlation in logs. */
  actorId: string;
}
