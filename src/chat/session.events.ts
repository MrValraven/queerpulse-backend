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
}
