import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import {
  ERASED_SENDER_MESSAGE_BATCH_SIZE,
  RELEASE_UNTIED_HELD_MESSAGES_SQL,
} from './erased-sender-messages';

/**
 * ENG-243 (c): releases the messages an account erasure HELD because an open or
 * escalated report was tied to their conversation. Once no such report remains,
 * each held row becomes an ordinary tombstone ("Message deleted") and loses its
 * `erased_sender_ref`, the same end state every un-held message reached at
 * erasure time. See `erased-sender-messages.ts` for the full rule.
 *
 * Daily is enough: a report being resolved is not urgent for the counterpart,
 * who could already read the held lines, and the tie is re-checked inside the
 * writing statement so a freshly filed report is never raced.
 *
 * Batched and idempotent. Each batch is its own statement (no long transaction
 * over a large erasure), and a released row can never match again, so a crash
 * mid-sweep simply resumes on the next tick.
 *
 * Single-instance job, like `AccountDeletionProcessorService`; two replicas
 * running it would do redundant but harmless work.
 */
@Injectable()
export class ErasedSenderMessageReleaseService {
  private readonly logger = new Logger(ErasedSenderMessageReleaseService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async releaseHeldMessagesDaily(): Promise<void> {
    // @nestjs/schedule does not wrap handlers: an escaping rejection would be
    // an unhandledRejection. The next tick retries.
    try {
      const releasedCount = await this.releaseHeldMessages();
      if (releasedCount > 0) {
        this.logger.log(
          `Released ${releasedCount} held message(s) from erased accounts`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Held message release sweep failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  /** Runs batches until one comes back short. Returns the rows released. */
  async releaseHeldMessages(): Promise<number> {
    let releasedCount = 0;
    for (;;) {
      const affectedCount = await this.releaseBatch();
      releasedCount += affectedCount;
      if (affectedCount < ERASED_SENDER_MESSAGE_BATCH_SIZE) {
        return releasedCount;
      }
    }
  }

  private async releaseBatch(): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      // `useStructuredResult` so an UPDATE reports its row count.
      const result = await queryRunner.query(
        RELEASE_UNTIED_HELD_MESSAGES_SQL,
        [ERASED_SENDER_MESSAGE_BATCH_SIZE],
        true,
      );
      return result.affected ?? 0;
    } finally {
      await queryRunner.release();
    }
  }
}
