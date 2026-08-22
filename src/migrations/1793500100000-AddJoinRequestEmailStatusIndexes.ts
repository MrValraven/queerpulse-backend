import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the two `join_requests` access patterns that had none.
 *
 * 1. `lower("email"), "status"` — the PUBLIC `POST /join-requests` runs two
 *    `WHERE lower(jr.email) = :email AND jr.status = :status` lookups on every
 *    call (the 30-day re-application cooldown against `declined` rows, then the
 *    duplicate-`pending` pre-check), and the admin list runs a third
 *    (`lower(email) IN (...) AND status = 'declined' GROUP BY lower(email)`)
 *    per page. The only expression index that existed was the PARTIAL unique on
 *    `lower(email) WHERE status = 'pending'`, which cannot serve the `declined`
 *    lookups at all — so they were sequential scans whose cost grows with the
 *    lifetime number of declined requests. The table is written by
 *    unauthenticated callers, so that growth is not under the operator's
 *    control.
 *
 * 2. `"status", "created_at"` — `list()` filters on `status` and keyset-
 *    paginates on `created_at`; neither column carried an index.
 *
 * Built `CONCURRENTLY` (hence `transaction = false`, which
 * `migrationsTransactionMode: 'each'` in data-source.ts allows per migration):
 * this table takes live public writes, and a plain `CREATE INDEX` would block
 * them for the duration. `migration:preflight` drops a leftover INVALID index
 * if a build is ever interrupted.
 */
export class AddJoinRequestEmailStatusIndexes1793500100000 implements MigrationInterface {
  name = 'AddJoinRequestEmailStatusIndexes1793500100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_join_requests_lower_email_status" ` +
        `ON "join_requests" (lower("email"), "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_join_requests_status_created_at" ` +
        `ON "join_requests" ("status", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_join_requests_status_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_join_requests_lower_email_status"`,
    );
  }
}
