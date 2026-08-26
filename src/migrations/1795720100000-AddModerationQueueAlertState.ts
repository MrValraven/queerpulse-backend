// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `moderation_queue_alert_state`, the deduplication behind the hourly
 * moderator-workload alert (TS-04), plus the one index the health read needs.
 *
 * THE TABLE. One row per queue that currently has an OPEN alert, keyed by the
 * queue's own code-defined key. Presence IS the state: no row means "this
 * queue is fine and nobody is owed an update", which is also the right reading
 * of an empty table on a fresh database, so no seed row is written. Without
 * it, an hourly cron would raise twenty-four identical alerts about a queue
 * that stayed critical for a day, and every Railway deploy would re-raise
 * every open alert from scratch: in-process memory cannot survive a restart,
 * which is exactly why this is a table and not a `Map`.
 *
 * `queue` is `varchar` holding a `ModerationQueueKey` value rather than a
 * Postgres enum, so adding a queue is a code-only change with no `ALTER TYPE`.
 * The same argument `NotificationPreferenceCategory` makes for staying a plain
 * string, and it is safe for the same reason: the only writer is one cron in
 * this repo, so there is no untrusted input for the column to guard.
 * `severity` is `varchar` for the same reason and only ever holds `warning` or
 * `critical`: a recovered queue has its row DELETED rather than lowered to
 * `ok`, so the table never grows past the number of queues actually in
 * trouble.
 *
 * NO FOREIGN KEYS: nothing here references another table. Nothing cascades,
 * and an account erasure cannot touch it, because the row is about a QUEUE and
 * never about a person. That is deliberate: this feature measures queues, not
 * moderators, and the schema is where that promise is cheapest to keep.
 *
 * THE INDEX. `IDX_join_requests_reviewed_at` is a PARTIAL index over decided
 * invite requests only. `ModerationQueueHealthService` computes the invite
 * queue's median response time from `reviewed_at >= now() - 7 days`, and no
 * index covered `reviewed_at`: that filter was a sequential scan of
 * `join_requests` on an admin path an hourly cron also walks. Partial (`WHERE
 * "reviewed_at" IS NOT NULL`) because pending rows have no `reviewed_at` and
 * can never match the filter, so indexing them would only cost writes on the
 * hot pending path.
 *
 * Every other filter this feature runs is already index-backed and no index is
 * added for it: `IDX_join_requests_status_created_at`, `IDX_reports_status`,
 * `IDX_appeals_status`, `verification_requests (status, type)` and
 * `IDX_ban_ratifications_status_expires_at`.
 *
 * TRANSACTIONAL, and safely so: `CREATE TABLE` on a new table plus a plain
 * `CREATE INDEX`. No `ALTER TYPE ... ADD VALUE` here (the notification type
 * this feature also needs lives in `1795720200000`, non-transactional as that
 * statement requires), and no `CREATE INDEX CONCURRENTLY`: `join_requests` is
 * a small, low-write table on this platform and the partial index builds in a
 * moment, so splitting the file into two phases would buy nothing.
 */
export class AddModerationQueueAlertState1795720100000 implements MigrationInterface {
  name = 'AddModerationQueueAlertState1795720100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "moderation_queue_alert_state" (
        "queue" character varying(64) NOT NULL,
        "severity" character varying(16) NOT NULL,
        "alerted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_moderation_queue_alert_state" PRIMARY KEY ("queue"),
        CONSTRAINT "CHK_moderation_queue_alert_state_severity"
          CHECK ("severity" IN ('warning', 'critical'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_join_requests_reviewed_at"
        ON "join_requests" ("reviewed_at")
        WHERE "reviewed_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_join_requests_reviewed_at"`);
    await queryRunner.query(`DROP TABLE "moderation_queue_alert_state"`);
  }
}
