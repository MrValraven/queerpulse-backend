import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { DEDUPED_ACTIVITY_KINDS } from './activity-describe';
import {
  Activity,
  ActivityKind,
  ActivitySubjectKind,
} from './entities/activity.entity';

export interface RecordActivityInput {
  userId: string;
  kind: ActivityKind;
  title: string;
  sub?: string | null;
  toLink?: string | null;
  // What the row is ABOUT, so the read path can re-check that the subject is
  // still public. A forum thread row carries the `forum_thread` kind and the
  // thread's slug, and `ActivityVisibilityService` re-checks it on every read
  // (deleted, scheduled, under review, masked or gated threads drop out).
  // Leave both null only for a subject with no visibility dimension. See
  // `ActivitySubjectKind`.
  subjectKind?: ActivitySubjectKind | null;
  subjectId?: string | null;
  occurredAt?: Date;
}

// A member's activity feed is a rolling window, not a permanent log: the profile
// only ever reads the newest handful (`ProfilesService.ACTIVITY_LIMIT`, and
// the public endpoint reads its own page size). This bounds each member's row
// count so a heavy poster can't grow the table without limit — after every
// insert we trim everything past the newest `MAX_ROWS_PER_USER`.
const MAX_ROWS_PER_USER = 60;

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
      const saved = await this.activities.save(
        this.activities.create({
          userId: input.userId,
          kind: input.kind,
          title: input.title,
          sub: input.sub ?? null,
          toLink: input.toLink ?? null,
          subjectKind: input.subjectKind ?? null,
          subjectId: input.subjectId ?? null,
          occurredAt: input.occurredAt ?? new Date(),
        }),
      );
      await this.replaceEarlierCopies(input, saved.id);
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
   * A row that states a lasting fact about one subject (an RSVP to this event,
   * a join of this community, a publish of this persona) replaces the member's
   * earlier rows about that same subject, so re-publishing a persona or
   * re-RSVPing an event moves the row to the top instead of stacking a copy.
   * Posts are never collapsed: each post is its own fact. See
   * `DEDUPED_ACTIVITY_KINDS`.
   *
   * Runs after the insert and spares the new row by id, so a failed insert
   * leaves the earlier row in place and the feed never loses the fact.
   */
  private async replaceEarlierCopies(
    input: RecordActivityInput,
    newRowId: string,
  ): Promise<void> {
    const subjectId = input.subjectId;
    if (!subjectId || !DEDUPED_ACTIVITY_KINDS.has(input.kind)) {
      return;
    }
    await this.activities.delete({
      id: Not(newRowId),
      userId: input.userId,
      kind: input.kind,
      subjectKind: input.subjectKind ?? IsNull(),
      subjectId,
    });
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
