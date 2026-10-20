import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { QUIZSHOW_LIMITS } from './quizshow.contract';
import { quizshowWriteFailureCode } from './quizshow-persistence.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

type QuizshowPurgeTable = 'quizshow_votes' | 'quizshow_answers';

/**
 * Pulse Live retention. Answers and votes go 30 days after their session
 * ended; abandoned sessions go whole after the same 30 days (players, teams
 * and everything else cascade). Players, teams and results of finished
 * sessions stay for as long as the session keeps its results.
 *
 * The daily sweep also abandons idle open sessions through the runtime and
 * drops lobby opens older than a day: the rate limit only reads the last
 * hour, and a member who never opens another lobby never prunes their own.
 * Single-replica job like every neighbouring cron; both steps catch and log
 * the count or the error code, and never throw, because an escaping rejection
 * from a scheduled handler becomes an unhandledRejection. Logs carry counts
 * and error codes only; payloads and names stay out of them.
 */
@Injectable()
export class QuizshowRetentionService {
  private readonly logger = new Logger(QuizshowRetentionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly runtime: QuizshowRuntimeService,
  ) {}

  // 06:00, the first free hour after the 01:00 to 05:00 retention jobs.
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async runDailySweep(): Promise<void> {
    await this.abandonIdleSessions();
    await this.purgeExpiredPlays();
    await this.sweepLobbyOpens();
  }

  /** Lobby opens older than a day, in batches; logs the count only. */
  async sweepLobbyOpens(): Promise<void> {
    try {
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      const cutoff = new Date(Date.now() - MILLISECONDS_PER_DAY);
      const lobbyOpensDeleted = await this.deleteInBatches(
        `WITH "deleted" AS (
           DELETE FROM "quizshow_lobby_opens"
           WHERE "id" IN (
             SELECT "id" FROM "quizshow_lobby_opens"
             WHERE "opened_at" < $1
             LIMIT $2
           )
           RETURNING 1
         )
         SELECT count(*)::int AS deleted_count FROM "deleted"`,
        cutoff,
        batchSize,
        maxBatches,
      );
      if (lobbyOpensDeleted > 0) {
        this.logger.log(
          `Pulse Live retention removed ${lobbyOpensDeleted} lobby open(s)`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `Pulse Live lobby opens sweep failed: ${quizshowWriteFailureCode(error)}`,
      );
    }
  }

  async abandonIdleSessions(): Promise<void> {
    try {
      const abandonedCount = await this.runtime.sweepIdleSessions(Date.now());
      if (abandonedCount > 0) {
        this.logger.log(
          `Pulse Live abandoned ${abandonedCount} idle session(s)`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `Pulse Live idle sweep failed: ${quizshowWriteFailureCode(error)}`,
      );
    }
  }

  async purgeExpiredPlays(): Promise<void> {
    try {
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      const cutoff = new Date(
        Date.now() - QUIZSHOW_LIMITS.retentionDays * MILLISECONDS_PER_DAY,
      );
      const votesDeleted = await this.deleteAnswerTableRows(
        'quizshow_votes',
        cutoff,
        batchSize,
        maxBatches,
      );
      const answersDeleted = await this.deleteAnswerTableRows(
        'quizshow_answers',
        cutoff,
        batchSize,
        maxBatches,
      );
      const sessionsDeleted = await this.deleteInBatches(
        `WITH "deleted" AS (
           DELETE FROM "quizshow_sessions"
           WHERE "id" IN (
             SELECT "id" FROM "quizshow_sessions"
             WHERE "status" = 'abandoned' AND "ended_at" < $1
             LIMIT $2
           )
           RETURNING 1
         )
         SELECT count(*)::int AS deleted_count FROM "deleted"`,
        cutoff,
        batchSize,
        maxBatches,
      );
      if (votesDeleted + answersDeleted + sessionsDeleted > 0) {
        this.logger.log(
          `Pulse Live retention removed ${votesDeleted} vote(s), ${answersDeleted} answer(s) and ${sessionsDeleted} abandoned session(s)`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `Pulse Live retention failed: ${quizshowWriteFailureCode(error)}`,
      );
    }
  }

  /** Votes and answers of sessions that ended before the cutoff, whatever their final status. */
  private deleteAnswerTableRows(
    table: QuizshowPurgeTable,
    cutoff: Date,
    batchSize: number,
    maxBatches: number,
  ): Promise<number> {
    return this.deleteInBatches(
      `WITH "deleted" AS (
         DELETE FROM "${table}"
         WHERE "id" IN (
           SELECT "row"."id" FROM "${table}" "row"
           JOIN "quizshow_sessions" "session" ON "session"."id" = "row"."session_id"
           WHERE "session"."ended_at" < $1
           LIMIT $2
         )
         RETURNING 1
       )
       SELECT count(*)::int AS deleted_count FROM "deleted"`,
      cutoff,
      batchSize,
      maxBatches,
    );
  }

  private async deleteInBatches(
    statement: string,
    cutoff: Date,
    batchSize: number,
    maxBatches: number,
  ): Promise<number> {
    let totalDeleted = 0;
    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const rows: { deleted_count: number }[] = await this.dataSource.query(
        statement,
        [cutoff, batchSize],
      );
      const deletedCount = rows[0]?.deleted_count ?? 0;
      totalDeleted += deletedCount;
      if (deletedCount < batchSize) break;
    }
    return totalDeleted;
  }
}
