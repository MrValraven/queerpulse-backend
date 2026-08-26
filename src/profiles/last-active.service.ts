import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ProfileLastActive } from './entities/profile-last-active.entity';
import {
  ActivityBand,
  ActivitySignal,
  bandFor,
  coarsenToMonth,
  dayKey,
} from './last-active';

/**
 * How many members the once-a-day throttle remembers before it prunes. Sized
 * for "everyone who signed in today, comfortably", because the map holds one
 * short string per member per day and the prune below is O(n) over it.
 */
const THROTTLE_MAX_ENTRIES = 50_000;

/**
 * Reads and writes the coarse "recently active" signal.
 *
 * THE WRITE IS THE INTERESTING PART, and it is guarded twice.
 *
 * 1. IN MEMORY, ONCE A DAY. Every session refresh would otherwise reach
 *    Postgres, and a member with the app open in three tabs refreshes several
 *    times an hour. `checkedToday` remembers "this member has already been
 *    considered today" and returns before any query runs. The key is a UTC
 *    calendar day and nothing else: this map is process-local, never persisted,
 *    and gone on restart, so it can never become a last-seen log itself. A
 *    restart costs at most one extra no-op statement per member per day.
 *
 * 2. IN SQL, ONLY ON A REAL CHANGE. The upsert's `DO UPDATE` carries a
 *    `WHERE ... IS DISTINCT FROM` predicate, so a member whose stored month is
 *    already the current month writes NOTHING: no row version, no WAL record,
 *    no lock held. In the steady state (a member who signed in earlier this
 *    month) the common case is genuinely zero writes, and the only months that
 *    ever cost a write are the first session of a new calendar month.
 *
 * Nothing here is allowed to fail a session refresh. `recordActivity` swallows
 * and logs: a member must never be signed out because a directory ornament
 * could not be written.
 */
@Injectable()
export class LastActiveService {
  private readonly logger = new Logger(LastActiveService.name);

  /** userId -> the UTC day we last considered them. Process-local, never stored. */
  private readonly checkedToday = new Map<string, string>();

  constructor(
    @InjectRepository(ProfileLastActive)
    private readonly lastActive: Repository<ProfileLastActive>,
  ) {}

  /**
   * Note that this member holds a live session, coarsened to the month.
   *
   * `now` is a parameter rather than a call to `new Date()` inside so the
   * once-a-day guard and the month boundary are directly testable.
   */
  async recordActivity(userId: string, now: Date = new Date()): Promise<void> {
    const today = dayKey(now);
    if (this.checkedToday.get(userId) === today) {
      return;
    }
    // Claim the day BEFORE awaiting. Several refreshes can land in the same
    // tick (a tab and the installed PWA rotating the same cookie), and marking
    // afterwards would let every one of them through to Postgres.
    this.rememberChecked(userId, today);
    try {
      await this.lastActive.query(
        `INSERT INTO profile_last_active ("user_id", "last_active_month")
         VALUES ($1, $2)
         ON CONFLICT ("user_id") DO UPDATE
           SET "last_active_month" = EXCLUDED."last_active_month"
           WHERE profile_last_active."last_active_month"
                 IS DISTINCT FROM EXCLUDED."last_active_month"`,
        [userId, coarsenToMonth(now)],
      );
    } catch (error) {
      // Release the day so a transient failure retries on the next refresh
      // instead of being suppressed until midnight UTC.
      this.checkedToday.delete(userId);
      this.logger.warn(
        `Could not record the coarse activity month for userId=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** One member's signal. `isHidden` is false when there is no row to read. */
  async getSignal(
    userId: string,
    now: Date = new Date(),
  ): Promise<ActivitySignal> {
    const row = await this.lastActive.findOne({ where: { userId } });
    if (!row) {
      return { band: null, isHidden: false };
    }
    return { band: bandFor(row.lastActiveMonth, now), isHidden: row.isHidden };
  }

  /**
   * Signals for a whole directory page in ONE query. Members with no row are
   * simply absent from the map, and `visibleBand` renders a missing entry as
   * nothing at all.
   */
  async getSignals(
    userIds: string[],
    now: Date = new Date(),
  ): Promise<Map<string, ActivitySignal>> {
    const signals = new Map<string, ActivitySignal>();
    if (!userIds.length) {
      return signals;
    }
    const rows = await this.lastActive.find({
      where: { userId: In(userIds) },
    });
    rows.forEach((row) => {
      signals.set(row.userId, {
        band: bandFor(row.lastActiveMonth, now),
        isHidden: row.isHidden,
      });
    });
    return signals;
  }

  /**
   * Flip the member's opt-out.
   *
   * A member who opts out BEFORE ever holding a session under this feature has
   * no row to flip, so one is created carrying the current month. That is
   * honest (they are signing in right now, which is how they reached the
   * switch) and it is what makes the preference stick rather than vanishing on
   * the next write.
   */
  async setHidden(
    userId: string,
    isHidden: boolean,
    now: Date = new Date(),
  ): Promise<ActivitySignal> {
    await this.lastActive.query(
      `INSERT INTO profile_last_active ("user_id", "last_active_month", "is_hidden")
       VALUES ($1, $2, $3)
       ON CONFLICT ("user_id") DO UPDATE
         SET "is_hidden" = EXCLUDED."is_hidden"
         WHERE profile_last_active."is_hidden" IS DISTINCT FROM EXCLUDED."is_hidden"`,
      [userId, coarsenToMonth(now), isHidden],
    );
    return this.getSignal(userId, now);
  }

  /**
   * The band a member sees for THEMSELVES, used by the preference screen so the
   * switch can say what it is actually hiding.
   */
  async getOwnBand(
    userId: string,
    now: Date = new Date(),
  ): Promise<ActivityBand | null> {
    return (await this.getSignal(userId, now)).band;
  }

  /**
   * Record the day, keeping the map bounded. Yesterday's keys are dropped
   * first; if the map is still oversized (a single day genuinely busier than
   * the cap) it is cleared outright, which costs one redundant no-op statement
   * per member and nothing else.
   */
  private rememberChecked(userId: string, today: string): void {
    if (this.checkedToday.size >= THROTTLE_MAX_ENTRIES) {
      this.checkedToday.forEach((day, key) => {
        if (day !== today) {
          this.checkedToday.delete(key);
        }
      });
      if (this.checkedToday.size >= THROTTLE_MAX_ENTRIES) {
        this.checkedToday.clear();
      }
    }
    this.checkedToday.set(userId, today);
  }
}
