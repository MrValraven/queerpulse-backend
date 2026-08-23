import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Community } from './entities/community.entity';

/** The trailing window "active this week" measures. */
const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keeps `communities.active_this_week` honest, so Discover can sort and filter
 * on liveliness IN SQL.
 *
 * WHAT "ACTIVE THIS WEEK" COUNTS, exactly: the number of DISTINCT members who
 * authored at least one community post or at least one reply to a community
 * post, in that community, in the trailing 7 days (a rolling window measured
 * back from the moment the job runs, never a calendar week). One member who
 * wrote thirty posts counts once. A member who only read, reacted, joined or
 * RSVP'd counts zero: this is a measure of who SPOKE. Tombstoned posts and
 * replies are excluded (deleted words are not activity), and rows whose author
 * was erased (`author_id IS NULL`) are excluded because there is no distinct
 * member left to count. Flat/global posts (`community_id IS NULL`) belong to no
 * community and are not counted anywhere.
 *
 * This is deliberately the SAME definition `CommunitiesService.statsForMany`
 * computes per request for a page of communities. The column exists so the
 * number can be ORDERed and WHEREd before pagination rather than after: today
 * the frontend drains every page of the directory to the browser to sort by it,
 * which cannot be paginated and degrades with every community added.
 *
 * The recompute is ONE statement. A grouped subquery unions post authors and
 * reply authors within the window, counts distinct authors per community, and
 * `LEFT JOIN`s that back onto the full communities table so a community with
 * no activity is written down as 0 rather than left holding last week's
 * number. There is no loop over communities anywhere in this file.
 *
 * Treat the column as approximate between runs; `activity_counted_at` records
 * how stale it is allowed to be, and readers should render a NULL there as
 * "unknown" instead of "quiet".
 */
@Injectable()
export class CommunityActivityCounterService {
  private readonly logger = new Logger(CommunityActivityCounterService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
  ) {}

  /**
   * Hourly. The window is seven days, so the number does not need to be
   * minute-fresh, and hourly keeps "Busy this week" from lagging a full day
   * behind a community that just woke up. Errors are caught and logged rather
   * than escaping: an unhandled rejection out of a `@nestjs/schedule` handler
   * takes the process down, and a stale activity count is not worth that.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async recomputeActivityCounts(): Promise<void> {
    try {
      await this.recompute();
    } catch (error) {
      this.logger.error(
        `Community activity recount failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }

  /**
   * The recompute itself, separated from the cron wrapper so it can be called
   * directly (a backfill, a test) without going through the scheduler.
   * Returns how many community rows were written.
   *
   * Safe on an empty table: the outer `LEFT JOIN` drives off `communities`, so
   * zero communities means zero rows updated and no error. Safe on a huge one:
   * the work is proportional to (communities) + (posts and replies inside the
   * 7-day window), the window predicate is the selective one, and both post
   * and reply lanes filter before the grouping rather than after.
   */
  async recompute(): Promise<number> {
    const now = new Date();
    const since = new Date(now.getTime() - ACTIVITY_WINDOW_MS);

    // Raw SQL because the statement is an UPDATE ... FROM over a LEFT JOIN of a
    // UNIONed grouped subquery, which TypeORM's query builder cannot express.
    // Every value is bound as a parameter; nothing is interpolated.
    const result = await this.communities.query(
      `UPDATE communities AS target
          SET active_this_week = activity.author_count,
              activity_counted_at = $1
         FROM (
           SELECT base.id AS community_id,
                  COALESCE(counted.author_count, 0)::int AS author_count
             FROM communities base
             LEFT JOIN (
               SELECT recent.community_id,
                      COUNT(DISTINCT recent.author_id) AS author_count
                 FROM (
                   SELECT p.community_id, p.author_id
                     FROM community_posts p
                    WHERE p.community_id IS NOT NULL
                      AND p.author_id IS NOT NULL
                      AND p.deleted_at IS NULL
                      AND p.created_at >= $2
                   UNION ALL
                   SELECT parent.community_id, r.author_id
                     FROM community_post_replies r
                     JOIN community_posts parent ON parent.id = r.post_id
                    WHERE parent.community_id IS NOT NULL
                      AND r.author_id IS NOT NULL
                      AND r.deleted_at IS NULL
                      AND r.created_at >= $2
                 ) recent
                GROUP BY recent.community_id
             ) counted ON counted.community_id = base.id
         ) activity
        WHERE target.id = activity.community_id`,
      [now, since],
    );

    // A raw `.query()` for an UPDATE resolves to `[rows, affectedCount]`, not
    // rows, so the count is the SECOND element. Reading element 0 as rows here
    // would hand back an empty array and report zero work on a run that in fact
    // updated the whole table.
    const affectedCount = Array.isArray(result)
      ? Number(result[1] ?? 0)
      : Number(result ?? 0);
    this.logger.log(
      `Recomputed active_this_week for ${affectedCount} community row(s) over the 7 days since ${since.toISOString()}`,
    );
    return affectedCount;
  }
}
