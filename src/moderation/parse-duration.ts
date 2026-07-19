import { BadRequestException } from '@nestjs/common';

// `ModActionInput.duration` shapes the admin UI sends, e.g. "7d", "24h".
const DURATION_RE = /^(\d{1,4})([hd])$/;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A suspension longer than this should be a `ban` (permanent) instead — an
 * explicit, auditable decision rather than a very large number nobody reads.
 * It also bounds the arithmetic below well clear of the Date range.
 */
export const MAX_SUSPENSION_DAYS = 365;

/**
 * Parses a moderation action's `duration` into an absolute expiry.
 *
 * Throws rather than defaulting on anything unrecognised. A malformed duration
 * that silently became `null` would be indistinguishable from `ban` — a typo
 * would turn a 7-day suspension into a permanent one, which is precisely the
 * class of "the action did something other than what the moderator intended"
 * bug this whole change exists to fix.
 *
 * @param from injected rather than read from the clock so tests are
 *   deterministic; callers pass the same `now` used for the rest of the action.
 */
export function parseDuration(duration: string, from: Date): Date {
  const match = DURATION_RE.exec(duration.trim());
  if (!match) {
    throw new BadRequestException(
      `Unsupported duration "${duration}". Expected a value like "7d" or "24h".`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (amount <= 0) {
    throw new BadRequestException('Duration must be greater than zero.');
  }

  const ms = unit === 'd' ? amount * DAY_MS : amount * HOUR_MS;

  if (ms > MAX_SUSPENSION_DAYS * DAY_MS) {
    throw new BadRequestException(
      `Suspensions cannot exceed ${MAX_SUSPENSION_DAYS} days. Use "ban" for a permanent action.`,
    );
  }

  return new Date(from.getTime() + ms);
}
