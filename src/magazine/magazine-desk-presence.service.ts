import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * How long an editor stays listed on a piece after their LAST socket watching
 * it drops, before they are actually removed. Mirrors the chat gateway's
 * `PRESENCE_GRACE_WINDOW_MS`: long enough to cover a page reload or the
 * gateway's own token-expiry reconnect, so the avatar stack on a colleague's
 * screen does not flicker off and back on, and short enough that an editor
 * who genuinely closed the piece is gone within seconds.
 *
 * An explicit `piece:unwatch` skips the grace: the editor said they left.
 */
export const DESK_PRESENCE_GRACE_WINDOW_MS = 10_000;

/** One editor as the desk renders them: enough for an avatar and a label. */
export interface DeskViewer {
  userId: string;
  name: string;
  initials: string;
}

/**
 * In-memory "who is viewing this piece" presence (single instance, MVP).
 * Isolated so a Redis-backed implementation is a one-file swap when scaling
 * past one process (spec §9).
 *
 * The single-instance assumption is asserted at boot by
 * `ChatSingleInstanceGuard`, whose doc lists everything a real scale-out needs.
 * This service shares that assumption: a second replica would hold its own
 * map, and editors connected to different replicas would never see each other.
 *
 * Shape: `pieceId -> userId -> socketIds`. One editor can have the same piece
 * open in two tabs; they are listed once and leave when the last tab does.
 */
@Injectable()
export class MagazineDeskPresenceService implements OnModuleDestroy {
  private readonly watchersByPiece = new Map<
    string,
    Map<string, Set<string>>
  >();
  // Reverse index so a disconnect finds every piece a socket watched without
  // scanning the whole map.
  private readonly piecesBySocket = new Map<string, Set<string>>();
  // Display identity per editor, written on every watch. Dropped once the
  // editor is on no piece at all, so the map stays bounded by live viewers.
  private readonly viewersByUser = new Map<string, DeskViewer>();
  // `${pieceId}:${userId}` -> the timer that removes a graced editor.
  private readonly pendingRemovals = new Map<string, NodeJS.Timeout>();

  /**
   * Records `socketId` watching `pieceId`. Returns true when this changed the
   * piece's viewer list (the editor was not already listed).
   */
  watch(pieceId: string, viewer: DeskViewer, socketId: string): boolean {
    this.viewersByUser.set(viewer.userId, viewer);
    this.cancelPendingRemoval(pieceId, viewer.userId);

    let watchers = this.watchersByPiece.get(pieceId);
    if (!watchers) {
      watchers = new Map();
      this.watchersByPiece.set(pieceId, watchers);
    }
    let sockets = watchers.get(viewer.userId);
    const isNewViewer = sockets === undefined;
    if (!sockets) {
      sockets = new Set();
      watchers.set(viewer.userId, sockets);
    }
    sockets.add(socketId);

    let pieces = this.piecesBySocket.get(socketId);
    if (!pieces) {
      pieces = new Set();
      this.piecesBySocket.set(socketId, pieces);
    }
    pieces.add(pieceId);
    return isNewViewer;
  }

  /** Whether this socket already watches the piece (a re-watch is free). */
  isWatching(socketId: string, pieceId: string): boolean {
    return this.piecesBySocket.get(socketId)?.has(pieceId) ?? false;
  }

  /** How many pieces one socket currently watches (the gateway caps this). */
  watchedPieceCount(socketId: string): number {
    return this.piecesBySocket.get(socketId)?.size ?? 0;
  }

  /**
   * An explicit leave: no grace. Returns true when the editor is no longer
   * listed on the piece (this was their last socket on it).
   */
  unwatch(pieceId: string, userId: string, socketId: string): boolean {
    this.piecesBySocket.get(socketId)?.delete(pieceId);
    if (this.piecesBySocket.get(socketId)?.size === 0) {
      this.piecesBySocket.delete(socketId);
    }
    const sockets = this.watchersByPiece.get(pieceId)?.get(userId);
    // Only a socket that actually watched the piece can take the editor off
    // it; a stray unwatch must not cut short another tab's grace window.
    if (!sockets?.delete(socketId) || sockets.size > 0) {
      return false;
    }
    this.cancelPendingRemoval(pieceId, userId);
    this.removeViewer(pieceId, userId);
    return true;
  }

  /**
   * A socket dropped. Every piece where it was the editor's last socket keeps
   * the editor listed for `DESK_PRESENCE_GRACE_WINDOW_MS`, then removes them
   * and calls `onGraceExpired(pieceId)` so the gateway can broadcast. A socket
   * reconnecting and re-watching inside the window cancels the removal.
   */
  releaseSocket(
    userId: string,
    socketId: string,
    onGraceExpired: (pieceId: string) => void,
  ): void {
    const pieces = this.piecesBySocket.get(socketId);
    this.piecesBySocket.delete(socketId);
    if (!pieces) {
      return;
    }
    for (const pieceId of pieces) {
      const sockets = this.watchersByPiece.get(pieceId)?.get(userId);
      if (!sockets) {
        continue;
      }
      sockets.delete(socketId);
      if (sockets.size > 0) {
        continue;
      }
      this.scheduleRemoval(pieceId, userId, onGraceExpired);
    }
  }

  /** Who is on one piece, in the order they arrived. */
  viewersOf(pieceId: string): DeskViewer[] {
    const watchers = this.watchersByPiece.get(pieceId);
    if (!watchers) {
      return [];
    }
    const viewers: DeskViewer[] = [];
    for (const userId of watchers.keys()) {
      const viewer = this.viewersByUser.get(userId);
      if (viewer) {
        viewers.push(viewer);
      }
    }
    return viewers;
  }

  /** Every piece with at least one viewer, for the desk-wide broadcast. */
  viewersByPiece(): Record<string, DeskViewer[]> {
    const byPiece: Record<string, DeskViewer[]> = {};
    for (const pieceId of this.watchersByPiece.keys()) {
      const viewers = this.viewersOf(pieceId);
      if (viewers.length > 0) {
        byPiece[pieceId] = viewers;
      }
    }
    return byPiece;
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingRemovals.values()) {
      clearTimeout(timer);
    }
    this.pendingRemovals.clear();
  }

  private scheduleRemoval(
    pieceId: string,
    userId: string,
    onGraceExpired: (pieceId: string) => void,
  ): void {
    // A duplicate disconnect for the same editor and piece must clear the
    // first timer explicitly: overwriting the map entry alone would orphan a
    // running `setTimeout` that still fires on its original schedule.
    this.cancelPendingRemoval(pieceId, userId);
    const removalKey = pendingRemovalKey(pieceId, userId);
    const timer = setTimeout(() => {
      this.pendingRemovals.delete(removalKey);
      // Re-read the live state: an editor who is back on the piece through a
      // path that skipped `watch` must still stay listed.
      const sockets = this.watchersByPiece.get(pieceId)?.get(userId);
      if (!sockets || sockets.size > 0) {
        return;
      }
      this.removeViewer(pieceId, userId);
      onGraceExpired(pieceId);
    }, DESK_PRESENCE_GRACE_WINDOW_MS);
    timer.unref?.();
    this.pendingRemovals.set(removalKey, timer);
  }

  private cancelPendingRemoval(pieceId: string, userId: string): void {
    const removalKey = pendingRemovalKey(pieceId, userId);
    const timer = this.pendingRemovals.get(removalKey);
    if (timer) {
      clearTimeout(timer);
      this.pendingRemovals.delete(removalKey);
    }
  }

  private removeViewer(pieceId: string, userId: string): void {
    const watchers = this.watchersByPiece.get(pieceId);
    watchers?.delete(userId);
    if (watchers?.size === 0) {
      this.watchersByPiece.delete(pieceId);
    }
    for (const otherWatchers of this.watchersByPiece.values()) {
      if (otherWatchers.has(userId)) {
        return;
      }
    }
    this.viewersByUser.delete(userId);
  }
}

function pendingRemovalKey(pieceId: string, userId: string): string {
  return `${pieceId}:${userId}`;
}
