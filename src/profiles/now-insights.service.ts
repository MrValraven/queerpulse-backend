import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Connection } from '../connections/entities/connection.entity';
import { Profile } from '../users/entities/profile.entity';
import { ProfileNowHistory } from './entities/profile-now-history.entity';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The card's stated window. Exported so the response cannot drift from it. */
export const NOW_WINDOW_DAYS = 90;
/** Response time reads over a longer span than the funnel: a member who
 *  answers everything within a day should not lose the line after a quiet
 *  quarter. */
const RESPONSE_WINDOW_DAYS = 180;
/** Below this, a median is one person's mood rather than a habit, so the card
 *  publishes no claim at all. */
const MIN_ANSWERED_FOR_MEDIAN = 3;
const HISTORY_LIMIT = 5;

export type RespondsWithin = 'day' | 'fewDays' | 'week';

export interface NowChipInsight {
  reason: string;
  count: number;
  lastHelloAt: string | null;
}

export interface NowInsights {
  windowDays: typeof NOW_WINDOW_DAYS;
  hellos: number;
  replies: number;
  perChip: NowChipInsight[];
  nowUpdatedAt: string | null;
  history: { text: string; startedAt: string; endedAt: string }[];
}

/**
 * The owner-only read behind the profile Now card.
 *
 * NOTHING HERE IS INSTRUMENTATION. Every figure is an aggregate over
 * `connections` rows that the connect flow already writes, grouped by the
 * `request_reason` the profile chips themselves set through `reasonValue()`.
 * No visit, view, or click is recorded anywhere to make this work, and none
 * may be added: see the spec's "no view counting" decision.
 *
 * KNOWN GAP: `connections` holds one row per pair, and the re-open-after-decline
 * path (`ConnectionsService`, around the "re-open a previously declined
 * relationship as a fresh request" write) reuses that existing row rather than
 * inserting a new one. It overwrites `requestReason` but never touches
 * `createdAt`, which is a `@CreateDateColumn` and is set once, at first
 * insert, for good. So a hello re-sent on a previously declined pair is
 * invisible to every window count here (`hellos`, `replies`, a chip's `count`
 * all key off `created_at >= :since`), and that chip's `lastHelloAt` keeps
 * reporting the original request's date, possibly years stale, instead of the
 * re-send. Closing this needs a separate `requestedAt` (or similar) column on
 * `connections` that the write path refreshes on every re-open, which is a
 * schema change outside this task's scope and the spec owner's call.
 *
 * A `requestedAt` column would only fix the date, not the reason: on that same
 * re-open path, `messageAfterDecline` (`ConnectionsService`) returns null for
 * both `requestMessage` and `requestReason` whenever `hasPriorDecline` is
 * true, so a hello re-sent after a decline loses its chip attribution outright
 * and a future fix has to restore that write, not just add the column.
 */
@Injectable()
export class NowInsightsService {
  constructor(
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(ProfileNowHistory)
    private readonly nowHistory: Repository<ProfileNowHistory>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  async getForOwner(userId: string): Promise<NowInsights> {
    const since = new Date(Date.now() - NOW_WINDOW_DAYS * DAY_MS);
    // One grouped scan serves the totals AND the per-chip rows: the totals are
    // the sum of the groups, so a second query for them would read the same
    // rows twice. Raw SQL inside the aggregate expressions means snake_case
    // column names (TypeORM only maps property names in `select`/`where`).
    const rows = await this.connections
      .createQueryBuilder('c')
      .select('c.request_reason', 'reason')
      .addSelect(
        'COUNT(*) FILTER (WHERE c.created_at >= :since)',
        'windowCount',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE c.created_at >= :since AND c.responded_at IS NOT NULL)',
        'windowReplies',
      )
      .addSelect('MAX(c.created_at)', 'lastHelloAt')
      .where('c.addressee_id = :userId', { userId })
      // Excludes system-written rows, e.g. the personal-invite auto-connect
      // (`ConnectionsService.createConnectionInTransaction`), from every figure
      // this scan produces (hellos, replies, each chip's count and
      // lastHelloAt). Matches the `system:` PREFIX rather than the exact
      // `system:autoConnect` string so any future system-created row is
      // excluded for free, with no change needed here.
      .andWhere(
        "(c.request_reason IS NULL OR c.request_reason NOT LIKE 'system:%')",
      )
      .setParameter('since', since)
      .groupBy('c.request_reason')
      .getRawMany<{
        reason: string | null;
        windowCount: string;
        windowReplies: string;
        lastHelloAt: Date | string | null;
      }>();

    const perChip: NowChipInsight[] = [];
    let hellos = 0;
    let replies = 0;
    for (const row of rows) {
      hellos += Number(row.windowCount);
      replies += Number(row.windowReplies);
      // A reasonless hello counts toward the funnel and belongs to no chip.
      if (row.reason === null) continue;
      perChip.push({
        reason: row.reason,
        count: Number(row.windowCount),
        lastHelloAt: row.lastHelloAt
          ? new Date(row.lastHelloAt).toISOString()
          : null,
      });
    }

    const [profile, history] = await Promise.all([
      this.profiles.findOne({
        where: { userId },
        select: { userId: true, nowUpdatedAt: true },
      }),
      this.nowHistory.find({
        where: { userId },
        order: { endedAt: 'DESC' },
        take: HISTORY_LIMIT,
      }),
    ]);

    return {
      windowDays: NOW_WINDOW_DAYS,
      hellos,
      replies,
      perChip,
      nowUpdatedAt: profile?.nowUpdatedAt
        ? profile.nowUpdatedAt.toISOString()
        : null,
      history: history.map((entry) => ({
        text: entry.text,
        startedAt: entry.startedAt.toISOString(),
        endedAt: entry.endedAt.toISOString(),
      })),
    };
  }

  /**
   * How fast this member answers, as a coarse phrase. Median rather than mean
   * so one request that sat for a month does not rewrite a habit of same-day
   * answers.
   */
  async getRespondsWithin(userId: string): Promise<RespondsWithin | null> {
    const since = new Date(Date.now() - RESPONSE_WINDOW_DAYS * DAY_MS);
    const row = await this.connections
      .createQueryBuilder('c')
      .select(
        'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.responded_at - c.created_at)))',
        'medianSeconds',
      )
      .addSelect('COUNT(*)', 'answered')
      .where('c.addressee_id = :userId', { userId })
      .andWhere('c.responded_at IS NOT NULL')
      .andWhere('c.created_at >= :since', { since })
      // Same system-row exclusion as `getForOwner`'s scan, and for the same
      // reason: an auto-connect row is already `Accepted` with `respondedAt`
      // set near-instantly, so left in, a single one is enough to pull a
      // genuinely slow responder's median toward "usually replies within a
      // day" once `MIN_ANSWERED_FOR_MEDIAN` is met. The `system:` prefix
      // excludes any future system-written row too, not just this one.
      .andWhere(
        "(c.request_reason IS NULL OR c.request_reason NOT LIKE 'system:%')",
      )
      .getRawOne<{ medianSeconds: number | null; answered: string }>();

    if (!row || Number(row.answered) < MIN_ANSWERED_FOR_MEDIAN) return null;
    // node-pg parses `float8` (what `PERCENTILE_CONT` returns) to a genuine JS
    // number, never a string, but a null median (no answered row at all) must
    // still be rejected explicitly: `Number(null)` is 0, a finite (and wrong)
    // hour count, and would otherwise slip past the finiteness check below.
    if (row.medianSeconds === null) return null;
    const medianSeconds = Number(row.medianSeconds);
    if (!Number.isFinite(medianSeconds)) return null;
    const hours = medianSeconds / 3600;
    if (hours <= 24) return 'day';
    if (hours < 24 * 7) return 'fewDays';
    return 'week';
  }
}
