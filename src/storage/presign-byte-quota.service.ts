import { Injectable } from '@nestjs/common';
import { uploadDailyQuotaReached } from './upload-error-codes';

/**
 * SEC-44: the bytes one member may presign per UTC day, across every upload
 * kind. 1 GiB is about 128 full-size 8 MB photos or 20 full-length Studio
 * tracks a day, far past any real member's use, and it caps what one account
 * can presign and abandon on a bucket with no lifecycle rules.
 */
export const DAILY_PRESIGN_BYTE_LIMIT = 1024 * 1024 * 1024;

interface DailyUsage {
  day: string;
  bytes: number;
}

/**
 * A per-member daily presign byte quota, kept in memory. The app runs as one
 * replica and the presign throttler (`UserPresignThrottlerGuard`) is in
 * memory too, so a restart resets both; the quota is a ceiling on abuse, and
 * a restart that forgives a day's count is an accepted cost.
 *
 * A presign is charged the byte size it declares, which `ContentLength` on
 * the signed PUT then enforces, before the credential is minted, and
 * refunded when minting fails, so a refused request costs nothing.
 */
@Injectable()
export class PresignByteQuotaService {
  private readonly usageByUserId = new Map<string, DailyUsage>();
  // The UTC day the map was last pruned for. The first charge of a new day
  // drops every earlier day's entry once, so the map holds one day of
  // active uploaders.
  private prunedForDay: string | null = null;

  /** Charges `byteSize` to `userId`'s day, or throws the coded 429 when the
   *  charge would pass {@link DAILY_PRESIGN_BYTE_LIMIT}. */
  charge(userId: string, byteSize: number, now: Date = new Date()): void {
    const day = now.toISOString().slice(0, 10);
    const current = this.usageByUserId.get(userId);
    const usedToday = current?.day === day ? current.bytes : 0;
    const charge = Math.max(0, byteSize);
    if (usedToday + charge > DAILY_PRESIGN_BYTE_LIMIT) {
      throw uploadDailyQuotaReached(DAILY_PRESIGN_BYTE_LIMIT);
    }
    if (this.prunedForDay !== day) {
      this.pruneEarlierDays(day);
      this.prunedForDay = day;
    }
    this.usageByUserId.set(userId, { day, bytes: usedToday + charge });
  }

  /** Gives back a charge whose presign failed. */
  refund(userId: string, byteSize: number, now: Date = new Date()): void {
    const day = now.toISOString().slice(0, 10);
    const current = this.usageByUserId.get(userId);
    if (current?.day !== day) return;
    current.bytes = Math.max(0, current.bytes - Math.max(0, byteSize));
  }

  private pruneEarlierDays(today: string): void {
    for (const [userId, usage] of this.usageByUserId) {
      if (usage.day !== today) this.usageByUserId.delete(userId);
    }
  }
}
