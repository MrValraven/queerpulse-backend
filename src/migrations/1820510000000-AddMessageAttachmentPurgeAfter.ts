// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-361: an unsend no longer destroys evidence.
 *
 * "Delete for everyone" (by the author or by staff) keeps the tombstoned row's
 * `body` and `attachment` server-side for an evidence hold, and stamps
 * `attachment_purge_after` with the moment that hold ends. The hourly
 * `MessageEvidenceHoldSweepService` then purges the stored bytes and blanks the
 * body for every tombstone whose hold has ended and that no open or escalated
 * report still names. Account erasure (task T4) stamps `now()` on an erased
 * member's messages and relies on the same sweep.
 *
 * NULL means "no hold": a live message, a tombstone the sweep has already
 * cleaned, or a tombstone old enough that `up()` deliberately leaves it alone.
 * `up()` backfills ONLY tombstones deleted within the last 30 days, and stamps
 * them with an ALREADY-ENDED hold rather than a live one; the comment on the
 * backfill itself says why, and what it therefore does not do. The index is
 * partial on exactly the rows the sweep reads, so it stays tiny on the
 * platform's highest-write table.
 *
 * `messages` takes an insert on every send, so the index is built
 * `CONCURRENTLY` and this migration opts out of the per-migration transaction
 * (honoured under `migrationsTransactionMode: 'each'`, see `data-source.ts`),
 * mirroring `1785000700000-AddMessageClientId.ts`. The column add is a plain
 * nullable add with no default, which Postgres applies without a table rewrite.
 */
export class AddMessageAttachmentPurgeAfter1820510000000 implements MigrationInterface {
  name = 'AddMessageAttachmentPurgeAfter1820510000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "attachment_purge_after" TIMESTAMP WITH TIME ZONE`,
    );
    // Backfill: tombstones written before this column existed still carry their
    // retained body, and nothing will ever blank it unless the sweep is given a
    // reason to look at the row. This hands the RECENT ones to the sweep with a
    // hold that has ALREADY ENDED (`now()`), which is exactly what the column
    // means for them, and it is the one honest value:
    //
    //  - it does not grant an evidence hold the bytes cannot back. These rows
    //    were deleted under the old behaviour, which purged the attachment
    //    bytes at delete time, so a LIVE hold would flip `canReport` back to
    //    true (see `MessagingCoreService.toMessageResponses`) for everything
    //    deleted in the last 30 days, and the report it invited would open a
    //    staff attachment route that can only 404. Stamping
    //    `deleted_at + 30 days` did precisely that;
    //  - `isKeyStillNeededByAnotherMessage` treats a non-NULL
    //    `attachment_purge_after` as "this tombstone still needs its key", so a
    //    future-dated hold would also keep a key shared with a forward alive 30
    //    days longer. An already-ended hold is cleared by the next hourly
    //    sweep instead;
    //  - the sweep still refuses to touch a row an open or escalated report
    //    names (`noHoldingReportPredicate`), so nothing under review is lost.
    //
    // Scope and cost: only tombstones deleted within the last 30 days, batched
    // by id so no single statement writes unbounded WAL over the platform's
    // highest-write table. Older tombstones are deliberately left at NULL: they
    // would gain nothing (their hold would be long over either way), and
    // sweeping the entire history of the table is not this migration's job.
    // Their retained bodies stay exactly as they are today, which is the
    // status quo this migration does not change.
    let cursorId = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const pageRows = (await queryRunner.query(
        `SELECT "id" FROM "messages"
           WHERE "deleted_at" IS NOT NULL
             AND "deleted_at" > now() - INTERVAL '30 days'
             AND "attachment_purge_after" IS NULL
             AND ("body" <> '' OR "attachment" IS NOT NULL)
             AND "id" > $1::uuid
           ORDER BY "id" ASC
           LIMIT 1000`,
        [cursorId],
      )) as { id: string }[];
      if (pageRows.length === 0) {
        break;
      }
      const pageIds = pageRows.map((row) => row.id);
      await queryRunner.query(
        `UPDATE "messages" SET "attachment_purge_after" = now() WHERE "id" = ANY($1::uuid[])`,
        [pageIds],
      );
      cursorId = pageIds[pageIds.length - 1]!;
      if (pageIds.length < 1000) {
        break;
      }
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_messages_attachment_purge_after" ON "messages" ("attachment_purge_after") WHERE "attachment_purge_after" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_messages_attachment_purge_after"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "attachment_purge_after"`,
    );
  }
}
