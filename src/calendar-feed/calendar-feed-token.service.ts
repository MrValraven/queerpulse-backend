import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { CalendarFeedToken } from './entities/calendar-feed-token.entity';

/** 32 random bytes, hex-encoded — 64 chars, matching the column width. */
const TOKEN_BYTES = 32;

/**
 * Mints, verifies and revokes the opaque, per-member calendar-feed token
 * `CalendarSubscribe` (queerpulse FE) copies into "Subscribe to your feed":
 * `{apiUrl}/calendar/feed/{token}`.
 *
 * A STORED random token, not a derived signature. The previous implementation
 * signed the member's user id with `JWT_ACCESS_SECRET` and accepted the result
 * forever, which meant:
 *  - a leaked feed URL could not be revoked at all without rotating the
 *    platform's access-token secret and logging every member out;
 *  - the member's internal uuid travelled inside the URL, disclosing it to the
 *    calendar provider and to anyone the link was shown to;
 *  - a credential with an unlimited lifetime shared the secret of one with a
 *    15-minute lifetime.
 *
 * Verification is now a single indexed lookup instead of an HMAC recomputation.
 * That is one query per feed poll — the calendar app's polling interval is
 * measured in hours, and being able to revoke the credential is worth
 * incomparably more than avoiding that round trip.
 *
 * `mint` is idempotent per member: it returns the EXISTING token when one is
 * stored, because the FE re-opens the subscribe affordance to re-copy the same
 * URL, and minting a new value there would silently break the calendar
 * subscription the member already added. Rotation is explicit, via
 * {@link revoke} + a subsequent mint (`DELETE /me/calendar-feed-token`).
 */
@Injectable()
export class CalendarFeedTokenService {
  constructor(
    @InjectRepository(CalendarFeedToken)
    private readonly tokens: Repository<CalendarFeedToken>,
  ) {}

  /** This member's live feed token, minting one on first use. */
  async mint(userId: string): Promise<string> {
    const existing = await this.tokens.findOne({ where: { userId } });
    if (existing) {
      return existing.token;
    }
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    // `orIgnore` on the per-user unique index absorbs a race between two tabs
    // both asking for the subscribe URL at once; the re-read below then returns
    // whichever insert won, so the two tabs never disagree about the URL.
    await this.tokens
      .createQueryBuilder()
      .insert()
      .into(CalendarFeedToken)
      .values({ userId, token })
      .orIgnore()
      .execute();
    const row = await this.tokens.findOneOrFail({ where: { userId } });
    return row.token;
  }

  /**
   * Returns the member's `userId` when `token` is a live stored token, or
   * `null` when it is unknown, malformed, or has been revoked. Stamps
   * `lastUsedAt` so a member (or an admin handling a report) can tell whether a
   * leaked URL is still being polled; the stamp is best-effort and never fails
   * the feed.
   */
  async verify(token: string): Promise<string | null> {
    // Cheap shape guard so a junk path segment never reaches the index.
    if (!/^[0-9a-f]{64}$/.test(token)) {
      return null;
    }
    const row = await this.tokens.findOne({ where: { token } });
    if (!row) {
      return null;
    }
    await this.tokens
      .update({ id: row.id }, { lastUsedAt: () => 'now()' })
      .catch(() => undefined);
    return row.userId;
  }

  /**
   * Invalidate this member's feed URL. Idempotent: revoking when nothing is
   * stored is a no-op success, so a member can hit "reset my calendar link"
   * twice without an error. The next `mint` issues a fresh token.
   */
  async revoke(userId: string): Promise<void> {
    await this.tokens.delete({ userId });
  }
}
