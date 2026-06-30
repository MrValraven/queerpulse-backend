import { Injectable } from '@nestjs/common';

/**
 * In-memory presence (single instance, MVP). Isolated so a Redis-backed
 * implementation is a one-file swap when scaling past one process (spec §9).
 */
@Injectable()
export class PresenceService {
  private readonly online = new Map<string, Set<string>>();

  /** Returns true if this is the user's FIRST live socket (offline→online). */
  add(userId: string, socketId: string): boolean {
    const sockets = this.online.get(userId);
    if (sockets) {
      sockets.add(socketId);
      return false;
    }
    this.online.set(userId, new Set([socketId]));
    return true;
  }

  /** Returns true if this was the user's LAST live socket (online→offline). */
  remove(userId: string, socketId: string): boolean {
    const sockets = this.online.get(userId);
    if (!sockets) {
      return false;
    }
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.online.delete(userId);
      return true;
    }
    return false;
  }

  isOnline(userId: string): boolean {
    return this.online.has(userId);
  }
}
