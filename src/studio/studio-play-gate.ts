import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

export const STUDIO_PLAY_PLAUSIBILITY_MILLISECONDS = 25_000;
export const STUDIO_PLAY_THROTTLE_WINDOW_MILLISECONDS = 60_000;
export const STUDIO_PLAY_THROTTLE_LIMIT = 4;

/** Internal answer of the gate; it never reaches the wire. */
export type StudioPlayGateDecision = 'admitted' | 'throttled' | 'too_soon';

/**
 * In-memory gate for play reports. It lives per process and resets on deploy,
 * like the `ThrottlerModule` storage in `app.module.ts` (single replica only).
 * A call that a later step skips still holds its slot, and the same marker
 * serves history on and paused. Both maps hold user ids and timestamps only.
 */
@Injectable()
export class StudioPlayGate {
  private readonly recentCallTimes = new Map<string, number[]>();
  private readonly lastAdmittedTimes = new Map<string, number>();

  admit(
    userId: string,
    nowMilliseconds: number = Date.now(),
  ): StudioPlayGateDecision {
    const windowStart =
      nowMilliseconds - STUDIO_PLAY_THROTTLE_WINDOW_MILLISECONDS;
    const callTimes = (this.recentCallTimes.get(userId) ?? []).filter(
      (callTime) => callTime > windowStart,
    );
    callTimes.push(nowMilliseconds);
    this.recentCallTimes.set(
      userId,
      callTimes.slice(-(STUDIO_PLAY_THROTTLE_LIMIT + 1)),
    );

    if (callTimes.length > STUDIO_PLAY_THROTTLE_LIMIT) {
      return 'throttled';
    }
    const lastAdmittedTime = this.lastAdmittedTimes.get(userId);
    if (
      lastAdmittedTime !== undefined &&
      nowMilliseconds - lastAdmittedTime < STUDIO_PLAY_PLAUSIBILITY_MILLISECONDS
    ) {
      return 'too_soon';
    }
    this.lastAdmittedTimes.set(userId, nowMilliseconds);
    return 'admitted';
  }

  @Interval('studio-play-gate-prune', STUDIO_PLAY_THROTTLE_WINDOW_MILLISECONDS)
  dropExpiredEntries(nowMilliseconds: number = Date.now()): void {
    const windowStart =
      nowMilliseconds - STUDIO_PLAY_THROTTLE_WINDOW_MILLISECONDS;
    for (const [userId, callTimes] of this.recentCallTimes) {
      const keptCallTimes = callTimes.filter(
        (callTime) => callTime > windowStart,
      );
      if (keptCallTimes.length === 0) {
        this.recentCallTimes.delete(userId);
      } else {
        this.recentCallTimes.set(userId, keptCallTimes);
      }
    }
    for (const [userId, admittedTime] of this.lastAdmittedTimes) {
      if (admittedTime <= windowStart) {
        this.lastAdmittedTimes.delete(userId);
      }
    }
  }

  trackedMemberCount(): number {
    return new Set([
      ...this.recentCallTimes.keys(),
      ...this.lastAdmittedTimes.keys(),
    ]).size;
  }
}
