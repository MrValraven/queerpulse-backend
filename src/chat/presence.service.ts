import { Injectable } from '@nestjs/common';

/**
 * How long a member stays reported "online" after their LAST socket drops
 * for a server-initiated token-expiry reconnect (ENG-219), before the offline
 * transition actually fires. Long enough to cover a normal reconnect (a JWT
 * refresh + a fresh handshake), short enough that a genuinely departed member
 * is not shown online for long if the "reconnect" never happens (their next
 * socket never arrives and the grace simply expires on schedule).
 */
export const PRESENCE_GRACE_WINDOW_MS = 10_000;

interface PendingOfflineEntry {
  timer: NodeJS.Timeout;
}

/**
 * In-memory presence (single instance, MVP). Isolated so a Redis-backed
 * implementation is a one-file swap when scaling past one process (spec §9).
 *
 * The single-instance assumption is asserted at boot by
 * `ChatSingleInstanceGuard`, whose doc lists everything a real scale-out needs.
 */
@Injectable()
export class PresenceService {
  private readonly online = new Map<string, Set<string>>();
  // ENG-219: members whose last REAL socket disconnected via a
  // server-initiated token-expiry drop (`ChatGateway.scheduleTokenExpiry`)
  // and are within `PRESENCE_GRACE_WINDOW_MS` of being reported offline.
  // Kept separate from `online` on purpose: a graced member's entry in
  // `online` is left in place (see `remove`), so `isOnline`/`onlineUserIds`
  // need no awareness of grace at all: to them a graced member never left.
  private readonly pendingOffline = new Map<string, PendingOfflineEntry>();

  /** Returns true if this is the user's FIRST live socket (offline→online). */
  add(userId: string, socketId: string): boolean {
    // A socket reconnecting inside the grace window cancels the pending
    // offline transition, since the member was never actually reported
    // offline (see `remove`), so this is not a fresh online transition
    // either; no caller should re-broadcast "online" for a member that never
    // left.
    const pending = this.pendingOffline.get(userId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingOffline.delete(userId);
    }
    const sockets = this.online.get(userId);
    if (sockets) {
      sockets.add(socketId);
      return false;
    }
    this.online.set(userId, new Set([socketId]));
    return true;
  }

  /**
   * Returns true if this was the user's LAST live socket AND the transition
   * to offline should be reported NOW (online→offline).
   *
   * `options.isGraced` marks a server-initiated token-expiry drop
   * (ENG-219): when the socket being removed was the member's last one AND
   * the drop is graced, `isOnline`/`onlineUserIds` keep reporting the member
   * present, most importantly so `PushMessageListener` does not push a DM
   * they are still looking at during the reconnect, and the actual offline
   * transition is deferred by `PRESENCE_GRACE_WINDOW_MS`, firing
   * `options.onGraceExpired` if no socket reconnects in the meantime. A
   * genuine disconnect (no `isGraced`) reports offline immediately, exactly
   * as before ENG-219.
   */
  remove(
    userId: string,
    socketId: string,
    options: { isGraced?: boolean; onGraceExpired?: () => void } = {},
  ): boolean {
    const sockets = this.online.get(userId);
    if (!sockets) {
      return false;
    }
    sockets.delete(socketId);
    if (sockets.size > 0) {
      return false;
    }
    if (!options.isGraced) {
      this.online.delete(userId);
      return true;
    }
    // Grace period: this was the member's last REAL socket, and the drop is
    // a planned server-initiated reconnect. Stay "online" (the entry in
    // `online` is left in place, still mapped to the now-empty `sockets` set
    // `add` will find and repopulate) and defer the offline transition.
    //
    // Any timer ALREADY pending for this member is cleared before being
    // replaced, defensively: `add` is the normal way a pending timer gets
    // cancelled, but a second graced `remove` landing for the same member
    // without an intervening `add` (e.g. a duplicate disconnect event) must
    // still cancel the first timer explicitly. Overwriting the map entry
    // alone would drop the only reference to it while leaving the real
    // `setTimeout` running, orphaned, and it would still fire and report the
    // member offline on its own original schedule.
    const existingPending = this.pendingOffline.get(userId);
    if (existingPending) {
      clearTimeout(existingPending.timer);
    }
    const timer = setTimeout(() => {
      this.pendingOffline.delete(userId);
      // Re-check the LIVE state here, instead of trusting this callback's
      // own premise: `add` is expected to always cancel this timer itself on
      // a reconnect, but re-reading `online` means a member who is genuinely
      // back online is never reported offline even if some other path ever
      // reconnects a socket without going through `add`.
      if ((this.online.get(userId)?.size ?? 0) > 0) {
        return;
      }
      this.online.delete(userId);
      options.onGraceExpired?.();
    }, PRESENCE_GRACE_WINDOW_MS);
    timer.unref?.();
    this.pendingOffline.set(userId, { timer });
    return false;
  }

  isOnline(userId: string): boolean {
    return this.online.has(userId);
  }

  /**
   * Every member with at least one live socket on THIS instance, INCLUDING a
   * member currently inside their post-token-expiry grace window (ENG-219).
   * `online` is exactly what this method already reads, and a graced member
   * is deliberately still in it (see `remove`).
   *
   * Backs `ChatSessionEnforcementService`'s periodic re-authorisation sweep,
   * which needs the set of members to re-check rather than a per-socket lookup.
   * A snapshot array (not the live map) so a caller iterating it can't be
   * tripped by a connect/disconnect landing mid-iteration.
   */
  onlineUserIds(): string[] {
    return [...this.online.keys()];
  }
}
