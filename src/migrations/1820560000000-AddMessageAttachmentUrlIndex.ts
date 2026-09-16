// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-369 follow-up: index the jsonb path every attachment serve looks up.
 *
 * `FilesController` resolves a `message-image` / `message-document` storage key
 * back to its message through `attachment ->> 'url'`, and does it TWICE per
 * download: `isMessageAttachmentParticipant` (the authorization check, on
 * every single serve of every attachment) and `documentDisplayFileName` (the
 * download's display name). Both use the identical predicate, so one
 * expression index serves both. Without it each lookup is a sequential scan of
 * `messages`, the platform's largest and highest-write table, and the cost is
 * paid per image render as well as per document download.
 *
 * PARTIAL on `attachment IS NOT NULL`: almost no message carries an
 * attachment, so this keeps the index a small fraction of the table's row
 * count. Both queries carry that same `AND attachment IS NOT NULL` clause
 * explicitly, because Postgres does not infer it from the `->>` test alone and
 * would otherwise refuse to use a partial index.
 *
 * `messages` takes an insert on every send, so the index is built
 * `CONCURRENTLY` and this migration opts out of the per-migration transaction
 * (honoured under `migrationsTransactionMode: 'each'`, see `data-source.ts`),
 * mirroring `1820510000000-AddMessageAttachmentPurgeAfter.ts`.
 */
export class AddMessageAttachmentUrlIndex1820560000000 implements MigrationInterface {
  name = 'AddMessageAttachmentUrlIndex1820560000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_messages_attachment_url" ON "messages" (("attachment" ->> 'url')) WHERE "attachment" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_messages_attachment_url"`,
    );
  }
}
