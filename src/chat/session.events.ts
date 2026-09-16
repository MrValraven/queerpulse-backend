/**
 * Cross-module hook so auth can force-drop a member's live sockets.
 *
 * The chat gateway listens for this event and disconnects every socket in the
 * member's `user:${userId}` room (logout, suspension, or refresh-token reuse).
 * The AUTH module must EMIT this event (`eventEmitter.emit(USER_SESSION_REVOKED,
 * { userId })`) from its logout / suspension / reuse-detection paths — the chat
 * module only consumes it, and cannot reach into auth to wire the emit.
 */
export const USER_SESSION_REVOKED = 'user.session.revoked';

export interface UserSessionRevokedEvent {
  userId: string;
  /**
   * The refresh-token FAMILY id being revoked (ENG-209). PRESENT for "sign
   * out this device" (`AccountService.revokeSession`): the gateway
   * (`ChatGateway.handleSessionRevoked`) can then POSITIVELY identify which
   * socket is the revoked device (an exact `data.sessionId` match), tell
   * only that one it was signed out, and leave the member's other live
   * sessions alone entirely.
   *
   * ABSENT for every emitter that does NOT single out one exact device:
   * `AuthService.revokeRefreshToken` (a single-device `/auth/logout`, which
   * names only ONE device but has no session id to identify it by here),
   * `AccountService.revokeOtherSessions` ("log out other devices", which
   * targets every device EXCEPT the caller's own, a partial set here),
   * `AccountService.revokeAllSessions` (which really does mean every
   * device), a suspension, and the 60s liveness sweep
   * (`ChatSessionEnforcementService`). The gateway cannot safely assert
   * `SESSION_REVOKED` to anyone on this path, since it cannot tell which (if
   * any) of the member's current sockets are the ones actually revoked, so
   * it disconnects the whole room WITHOUT a frame and lets each socket's own
   * reconnect handshake re-authenticate and sort out the truth.
   */
  sessionId?: string;
}
