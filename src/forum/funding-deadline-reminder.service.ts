import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { FundingDeadlineReminder } from './entities/funding-deadline-reminder.entity';
import {
  FUNDING_REMINDER_LOOKAHEAD_MS,
  FUNDING_REMINDER_TIME_ZONE,
  FundingReminderStage,
  reminderStageFor,
} from './funding-reminder-stage';
import { fundingSaverVisibleSql } from './funding-saver-visibility';

/**
 * A ceiling per run, the shape `HousingListingExpirySweeperService` uses. The
 * SQL keeps only rows due today and not yet claimed, so the cap counts real
 * work. A day with more due rows than the cap leaves the rest unreminded: a
 * missed day is never caught up, so the run logs a warning at the cap.
 */
const MAX_REMINDER_CANDIDATES_PER_RUN = 2000;
const REMINDER_INSERT_BATCH_SIZE = 500;

interface ReminderCandidateRow {
  user_id: string;
  thread_id: string;
  thread_slug: string;
  thread_title: string;
  deadline: Date | string;
}

interface ClaimedReminderRow {
  user_id: string;
  thread_id: string;
  stage: FundingReminderStage;
}

interface ReminderCandidate {
  userId: string;
  threadId: string;
  threadSlug: string;
  threadTitle: string;
  deadline: Date;
  stage: FundingReminderStage;
}

// Saved open calls closing inside the lookahead, for members who can still
// read them. Each predicate mirrors a gate the thread page applies: withdrawn
// threads, scheduled or held threads (the shared read gate), an OP a
// moderator hid or removed, a block either way between saver and author, and
// a gated community or space the saver cannot read (no counting roster row,
// no parent staff role), the same test as the thread page's community gate.
const CANDIDATE_SQL = `
  SELECT "saved"."user_id" AS "user_id",
         "thread"."id" AS "thread_id",
         "thread"."slug" AS "thread_slug",
         "thread"."title" AS "thread_title",
         "funding"."deadline" AS "deadline"
    FROM "forum_thread_funding" "funding"
    JOIN "forum_thread" "thread"
      ON "thread"."id" = "funding"."thread_id"
    JOIN "saved_item" "saved"
      ON "saved"."subject_type" = 'post'
     AND "saved"."subject_id" = "thread"."slug"
   WHERE ${fundingSaverVisibleSql('"thread"', '"saved"')}
     AND "funding"."deadline" > $1
     AND "funding"."deadline" <= $2
     AND (
           ("funding"."deadline" AT TIME ZONE 'Europe/Lisbon')::date
             - ($1::timestamptz AT TIME ZONE 'Europe/Lisbon')::date
         ) IN (1, 7)
     AND NOT EXISTS (
           SELECT 1
             FROM "funding_deadline_reminder" "sent"
            WHERE "sent"."user_id" = "saved"."user_id"
              AND "sent"."thread_id" = "thread"."id"
              AND "sent"."deadline" = "funding"."deadline"
              AND "sent"."stage" = CASE
                    WHEN ("funding"."deadline" AT TIME ZONE 'Europe/Lisbon')::date
                       - ($1::timestamptz AT TIME ZONE 'Europe/Lisbon')::date = 7
                    THEN '7d' ELSE '1d' END
         )
   ORDER BY "funding"."deadline" ASC, "saved"."user_id" ASC
   LIMIT $3`;

// The claim. The primary key (user, thread, stage, deadline) makes a second
// replica or a crash-rerun insert nothing, and RETURNING says exactly which
// rows this run owns.
const CLAIM_SQL = `
  INSERT INTO "funding_deadline_reminder" ("user_id", "thread_id", "stage", "deadline")
  SELECT "candidate"."user_id", "candidate"."thread_id", "candidate"."stage", "candidate"."deadline"
    FROM unnest($1::uuid[], $2::uuid[], $3::varchar[], $4::timestamptz[])
         AS "candidate"("user_id", "thread_id", "stage", "deadline")
  ON CONFLICT DO NOTHING
  RETURNING "user_id", "thread_id", "stage"`;

function claimKey(userId: string, threadId: string, stage: string): string {
  return `${userId}:${threadId}:${stage}`;
}

/**
 * Funding & Grants (P3): reminds members who saved an open call 7 days and 1
 * day before it closes, once each per deadline.
 *
 * In-app only. QueerPulse sends no email, and nothing here says otherwise.
 *
 * AT MOST ONCE. Rows are claimed before the notification is written, the
 * order `HousingListingExpirySweeperService.warnExpiringListings` uses: a
 * crash between the two loses one reminder, and the reverse order would let a
 * crash send the same reminder twice.
 *
 * No actor on the notification: the call's own deadline is speaking.
 */
@Injectable()
export class FundingDeadlineReminderService {
  private readonly logger = new Logger(FundingDeadlineReminderService.name);

  constructor(
    @InjectRepository(FundingDeadlineReminder)
    private readonly reminders: Repository<FundingDeadlineReminder>,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 9 * * *', { timeZone: FUNDING_REMINDER_TIME_ZONE })
  async sendDueReminders(): Promise<void> {
    try {
      await this.runReminderPass(new Date());
    } catch (error) {
      // An escaping rejection from a schedule handler becomes an
      // unhandledRejection; tomorrow's tick retries.
      this.logger.error(
        `Funding deadline reminder sweep failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }

  /** One pass at `now`. Returns how many members were reminded. */
  async runReminderPass(now: Date): Promise<number> {
    const rows = await this.reminders.query<ReminderCandidateRow[]>(
      CANDIDATE_SQL,
      [
        now,
        new Date(now.getTime() + FUNDING_REMINDER_LOOKAHEAD_MS),
        MAX_REMINDER_CANDIDATES_PER_RUN,
      ],
    );
    if (rows.length >= MAX_REMINDER_CANDIDATES_PER_RUN) {
      this.logger.warn(
        `Funding reminder sweep hit its ${MAX_REMINDER_CANDIDATES_PER_RUN} row cap; later rows miss today's reminder`,
      );
    }
    const candidates = rows.flatMap((row): ReminderCandidate[] => {
      const deadline = new Date(row.deadline);
      const stage = reminderStageFor(deadline, now);
      if (stage === null) return [];
      return [
        {
          userId: row.user_id,
          threadId: row.thread_id,
          threadSlug: row.thread_slug,
          threadTitle: row.thread_title,
          deadline,
          stage,
        },
      ];
    });
    let remindedCount = 0;
    for (
      let batchStart = 0;
      batchStart < candidates.length;
      batchStart += REMINDER_INSERT_BATCH_SIZE
    ) {
      try {
        remindedCount += await this.claimAndNotify(
          candidates.slice(batchStart, batchStart + REMINDER_INSERT_BATCH_SIZE),
        );
      } catch (error) {
        // A member erased or a thread deleted between the read and the claim
        // fails the insert; the remaining batches still run.
        this.logger.error(
          `Funding reminder batch at ${batchStart} failed: ${String(error)}`,
        );
      }
    }
    if (remindedCount > 0) {
      this.logger.log(`Reminded ${remindedCount} member(s) of a closing call`);
    }
    return remindedCount;
  }

  private async claimAndNotify(batch: ReminderCandidate[]): Promise<number> {
    const claimedRows = await this.reminders.query<ClaimedReminderRow[]>(
      CLAIM_SQL,
      [
        batch.map((candidate) => candidate.userId),
        batch.map((candidate) => candidate.threadId),
        batch.map((candidate) => candidate.stage),
        batch.map((candidate) => candidate.deadline.toISOString()),
      ],
    );
    const claimedKeys = new Set(
      claimedRows.map((row) => claimKey(row.user_id, row.thread_id, row.stage)),
    );
    // One notification write per (call, stage), carrying every claimed saver.
    const noticesByThreadStage = new Map<
      string,
      { candidate: ReminderCandidate; userIds: string[] }
    >();
    for (const candidate of batch) {
      if (
        !claimedKeys.has(
          claimKey(candidate.userId, candidate.threadId, candidate.stage),
        )
      ) {
        continue;
      }
      const noticeKey = `${candidate.threadId}:${candidate.stage}`;
      const notice = noticesByThreadStage.get(noticeKey);
      if (notice) {
        notice.userIds.push(candidate.userId);
      } else {
        noticesByThreadStage.set(noticeKey, {
          candidate,
          userIds: [candidate.userId],
        });
      }
    }
    let remindedCount = 0;
    for (const { candidate, userIds } of noticesByThreadStage.values()) {
      try {
        const deliveredIds = await this.notifications.createForRecipients(
          userIds,
          NotificationType.FundingDeadlineSoon,
          {
            source: 'forum',
            threadSlug: candidate.threadSlug,
            threadTitle: candidate.threadTitle,
            deadline: candidate.deadline.toISOString(),
            stage: candidate.stage,
          },
        );
        remindedCount += deliveredIds.length;
      } catch (error) {
        // The claims stand: dropping them so tomorrow retries would turn a
        // once-only reminder into a daily one.
        this.logger.warn(
          `Funding reminder for thread ${candidate.threadId} (${candidate.stage}) was claimed but not delivered: ${String(error)}`,
        );
      }
    }
    return remindedCount;
  }
}
