import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supporting indexes for two foreign-key columns that had none (CNT-20, the
 * in-scope subset of that finding):
 *
 *   - `magazine_writer_applications.reviewed_by` -> `users(id)` ON DELETE SET
 *     NULL (`1790600000000-AddMagazineWriterApplications.ts:30,48` creates the
 *     column and the FK, and indexes only `user_id`).
 *   - `subprofile_invites.invited_by_user_id` -> `users(id)`
 *     (`1785788091586-AddSubprofileCoOwnership.ts:45,50,53` indexes
 *     `subprofile_id` and `invited_user_id`, but not the inviter).
 *
 * Postgres does NOT auto-index a foreign-key column. It only indexes the
 * referenced side (the PK). So every hard delete of a `users` row — the
 * account-erasure path — has to sequentially scan each referencing table to
 * find and fix up rows, taking an ACCESS SHARE lock on each while it does.
 * That cost grows with the table, on a path a member is waiting on.
 * `subprofile_invites.invited_by_user_id` is additionally queried per member
 * ("invites I sent").
 *
 * The other 18 columns in CNT-20 belong to governance, roadmap, events,
 * conversations, verification and platform-settings tables, which are outside
 * this change's module scope; they need their own migration alongside those
 * modules.
 *
 * Built `CREATE INDEX CONCURRENTLY` so neither table is locked against writes.
 * `CONCURRENTLY` cannot run inside a transaction block, so `transaction =
 * false` opts this migration out (honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). Run it alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddContentModuleForeignKeyIndexes1793640000000 implements MigrationInterface {
  name = 'AddContentModuleForeignKeyIndexes1793640000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_magazine_writer_applications_reviewed_by" ` +
        `ON "magazine_writer_applications" ("reviewed_by")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_subprofile_invites_invited_by_user_id" ` +
        `ON "subprofile_invites" ("invited_by_user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_subprofile_invites_invited_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_magazine_writer_applications_reviewed_by"`,
    );
  }
}
