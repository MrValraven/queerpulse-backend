import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Message } from './entities/message.entity';
import { MessagesService } from './messages.service';

/** Rows released per query. Small enough that one UPDATE never holds many row
 *  locks on the platform's highest-write table. */
export const EVIDENCE_HOLD_SWEEP_BATCH_SIZE = 200;

/** Batches per hourly run, so one run is bounded (5,000 rows) however large the
 *  backlog is. A backlog (an erased heavy user, a long outage) drains over
 *  consecutive runs instead of one run holding the connection for minutes. */
export const EVIDENCE_HOLD_SWEEP_MAX_BATCHES_PER_RUN = 25;

/** A report in either status still needs the evidence it points at. A resolved
 *  report has had its decision, so it releases the hold. */
const HOLDING_REPORT_STATUSES = [ReportStatus.Open, ReportStatus.Escalated];

/**
 * The "no open or escalated report names this message" predicate, over an outer
 * message-id reference. The SELECT aliases the table `message`; the UPDATE has
 * no alias, so it references `messages` directly.
 */
function noHoldingReportPredicate(outerMessageIdReference: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM "reports" "holding_report"
    WHERE "holding_report"."subject_type" = :heldSubjectType
      AND "holding_report"."subject_id" = ${outerMessageIdReference}::text
      AND "holding_report"."status" IN (:...holdingReportStatuses)
  )`;
}

const HOLDING_REPORT_PARAMETERS = {
  heldSubjectType: ReportSubjectType.Message,
  holdingReportStatuses: HOLDING_REPORT_STATUSES,
};

/**
 * PRD-361: ends the evidence hold on messages deleted for everyone.
 *
 * "Delete for everyone" keeps a tombstone's body and attachment bytes for
 * `MESSAGE_DELETE_EVIDENCE_HOLD_DAYS`, so an unsent image can still be reported
 * and reviewed. Every hour this takes tombstones whose `attachment_purge_after`
 * has passed and that NO open or escalated `message` report names, and for each
 * one: blanks `body`, NULLs `attachment` and `attachment_purge_after`, then
 * purges the stored bytes through `MessagesService.purgeReleasedAttachmentBytes`
 * (which still keeps an object any other live message, or any other
 * still-held tombstone, references).
 *
 * The row is released FIRST, in one conditional UPDATE that re-checks every
 * predicate (including the report one), and bytes are purged only for the rows
 * that UPDATE actually returned. So a report filed between the read and the
 * write keeps its evidence, a second instance running the same batch purges
 * nothing twice, and a failed purge leaves an unreferenced object the storage
 * orphan sweep can reclaim rather than a row pointing at nothing.
 *
 * Contract with account erasure (task T4): an erased member's non-held messages
 * are written as `deleted_at = now(), body = '', attachment_purge_after =
 * now()`. They match this sweep on its next run like any released hold, which
 * is how their bytes get purged. Do not filter them out.
 *
 * Errors are logged and swallowed, matching every other `@Cron` sweeper here:
 * an escaping rejection from a `@nestjs/schedule` handler becomes an
 * unhandledRejection.
 */
@Injectable()
export class MessageEvidenceHoldSweepService {
  private readonly logger = new Logger(MessageEvidenceHoldSweepService.name);

  /** One run per process at a time: an hourly tick that lands while a large
   *  backlog is still draining skips instead of competing for the same rows. */
  private isSweepRunning = false;

  constructor(
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly messagesService: MessagesService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleHourlySweep(): Promise<void> {
    if (this.isSweepRunning) {
      return;
    }
    this.isSweepRunning = true;
    try {
      const releasedCount = await this.sweepReleasedHolds();
      if (releasedCount > 0) {
        this.logger.log(
          `Released the evidence hold on ${releasedCount} deleted message(s)`,
        );
      }
    } catch (error) {
      this.logger.error(`Message evidence hold sweep failed: ${String(error)}`);
    } finally {
      this.isSweepRunning = false;
    }
  }

  /**
   * One bounded pass. Returns how many rows were released. Idempotent: a row
   * already released has a NULL `attachment_purge_after` and never matches
   * again. `now` is injectable purely for tests.
   */
  async sweepReleasedHolds(now: Date = new Date()): Promise<number> {
    let releasedCount = 0;
    for (
      let batchIndex = 0;
      batchIndex < EVIDENCE_HOLD_SWEEP_MAX_BATCHES_PER_RUN;
      batchIndex += 1
    ) {
      const dueMessages = await this.messages
        .createQueryBuilder('message')
        .withDeleted()
        .select(['message.id', 'message.attachment'])
        .where('message.deletedAt IS NOT NULL')
        .andWhere('message.attachmentPurgeAfter IS NOT NULL')
        .andWhere('message.attachmentPurgeAfter <= :now', { now })
        .andWhere(
          noHoldingReportPredicate('"message"."id"'),
          HOLDING_REPORT_PARAMETERS,
        )
        .orderBy('message.attachmentPurgeAfter', 'ASC')
        .limit(EVIDENCE_HOLD_SWEEP_BATCH_SIZE)
        .getMany();
      if (dueMessages.length === 0) {
        break;
      }

      const releasedIds = new Set(
        await this.releaseRows(
          dueMessages.map((message) => message.id),
          now,
        ),
      );
      releasedCount += releasedIds.size;

      for (const message of dueMessages) {
        if (!releasedIds.has(message.id) || !message.attachment) {
          continue;
        }
        await this.messagesService.purgeReleasedAttachmentBytes(
          message.id,
          message.attachment,
        );
      }

      if (dueMessages.length < EVIDENCE_HOLD_SWEEP_BATCH_SIZE) {
        break;
      }
    }
    return releasedCount;
  }

  /** Blank and un-hold the given rows, re-checking every predicate at write
   *  time. Returns the ids this call actually released. */
  private async releaseRows(
    messageIds: string[],
    now: Date,
  ): Promise<string[]> {
    const result = await this.messages
      .createQueryBuilder()
      .update(Message)
      .set({ body: '', attachment: null, attachmentPurgeAfter: null })
      .where('id IN (:...messageIds)', { messageIds })
      .andWhere('deleted_at IS NOT NULL')
      .andWhere('attachment_purge_after IS NOT NULL')
      .andWhere('attachment_purge_after <= :now', { now })
      .andWhere(
        noHoldingReportPredicate('"messages"."id"'),
        HOLDING_REPORT_PARAMETERS,
      )
      .returning(['id'])
      .execute();
    const rawRows = (result.raw ?? []) as Array<{ id: string }>;
    return rawRows.map((row) => row.id);
  }
}
