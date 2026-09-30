// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-499. Erasing an account was deleting every data-subject request that
 * member had filed, including one still open inside its 30-day statutory
 * deadline.
 *
 * `dsar_request.user_id` was declared `ON DELETE CASCADE` in
 * `AddAccountManagement1782800030000`, so the hard delete of the `users` row
 * in `AccountDeletionProcessorService` took the requests with it. The
 * platform then kept no record of having received a statutory request, or of
 * how and when it answered one. `deletion_request` lost its FK in
 * `AddDeletionErasureSupport1782800700000` for the same reason: a record of a
 * data-rights request has to outlive the person it is about.
 *
 * This flips the requester FK to `ON DELETE SET NULL`. The request survives
 * an erasure with no requester, and the admin DSAR queue renders it with a
 * null `member` and `isRequesterErased: true` (see `admin-dsar-response.ts`).
 * Before the user row goes, `AccountDeletionProcessorService` (step 2e) wipes
 * the member's own free text: `details` becomes '' and `context` becomes
 * NULL. The row keeps its reference, article, scopes, status, dates, outcome
 * note and closing operator, which is the minimum that proves the request was
 * received and answered.
 *
 * `resolved_by_user_id` is already `ON DELETE SET NULL`
 * (`AddDsarOutcome1794570000000`), so both people on the row are now handled
 * the same way.
 *
 * The column becomes nullable first, since a `SET NULL` rule on a `NOT NULL`
 * column is a constraint Postgres accepts at DDL time and only fails on at
 * delete time.
 *
 * Purely transactional: `IDX_dsar_request_user_id` already exists from
 * `AddAccountManagement1782800030000`, so the `SET NULL` action finds its
 * referencing rows through an index, and `ALTER COLUMN ... DROP NOT NULL`
 * leaves that index in place.
 */
export class DsarRequestUserSetNullOnErasure1827500000000 implements MigrationInterface {
  name = 'DsarRequestUserSetNullOnErasure1827500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dsar_request" DROP CONSTRAINT "FK_dsar_request_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dsar_request" ALTER COLUMN "user_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "dsar_request" ADD CONSTRAINT "FK_dsar_request_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Same caveat as `SetNullForumThreadAuthorOnUserErasure1823800300000`'s
    // down(): restoring NOT NULL only succeeds while no request has actually
    // been orphaned by an erasure. Once a requester has been erased, `SET NOT
    // NULL` correctly fails. The orphaned rows are statutory records, so
    // down() leaves them for the maintainer to decide on and deletes nothing.
    await queryRunner.query(
      `ALTER TABLE "dsar_request" DROP CONSTRAINT "FK_dsar_request_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dsar_request" ALTER COLUMN "user_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "dsar_request" ADD CONSTRAINT "FK_dsar_request_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }
}
