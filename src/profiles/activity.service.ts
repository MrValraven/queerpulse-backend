import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityKind } from './entities/activity.entity';

export interface RecordActivityInput {
  userId: string;
  kind: ActivityKind;
  title: string;
  sub?: string | null;
  toLink?: string | null;
  occurredAt?: Date;
}

// A member's activity feed is a rolling window, not a permanent log: the profile
// only ever reads the newest handful (`ProfilesService.ACTIVITY_LIMIT` = 6, and
// the public endpoint reads the same page size). This bounds each member's row
// count so a heavy poster can't grow the table without limit — after every
// insert we trim everything past the newest `MAX_ROWS_PER_USER`.
const MAX_ROWS_PER_USER = 40;

/**
 * Writes rows to the `activities` table on genuine, publicly-visible member
 * actions (an event RSVP, a forum thread, a post in a public community).
 *
 * Every write is BEST-EFFORT: `record` never throws. Activity is a secondary,
 * derived signal — losing a row must never fail (or roll back) the primary
 * action that triggered it. Listeners call this from the `emit` bus after the
 * primary write has committed, so a failure here is isolated to the missing
 * activity row and nothing else.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activities: Repository<Activity>,
  ) {}

  async record(input: RecordActivityInput): Promise<void> {
    try {
      await this.activities.save(
        this.activities.create({
          userId: input.userId,
          kind: input.kind,
          title: input.title,
          sub: input.sub ?? null,
          toLink: input.toLink ?? null,
          occurredAt: input.occurredAt ?? new Date(),
        }),
      );
      await this.trim(input.userId);
    } catch (error) {
      // Swallow: a failed activity write must not break the member action that
      // caused it. Logged at warn so it's visible without being an error page.
      this.logger.warn(
        `Failed to record ${input.kind} activity for member ${input.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Delete this member's activity rows past the newest `MAX_ROWS_PER_USER`.
   * A single DELETE with a keep-set subquery — never a read-then-delete, which
   * could race a concurrent insert.
   */
  private async trim(userId: string): Promise<void> {
    await this.activities
      .createQueryBuilder()
      .delete()
      .from(Activity)
      .where('user_id = :userId', { userId })
      .andWhere(
        `id NOT IN (
          SELECT keep.id FROM activities keep
          WHERE keep.user_id = :userId
          ORDER BY keep.occurred_at DESC
          LIMIT :cap
        )`,
        { userId, cap: MAX_ROWS_PER_USER },
      )
      .execute();
  }
}
