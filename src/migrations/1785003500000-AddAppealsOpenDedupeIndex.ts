import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs `ModerationService.submitAppeal`'s "one OPEN appeal per member per
 * action" de-duplication with real database guards — before `POST /appeals`
 * existed nothing created appeals, so the `appeals` table had no such
 * constraint. The service does a check-then-insert (`findOne` then `save`), so
 * two concurrent identical filings could both miss the read and both insert.
 *
 * Adds TWO partial unique indexes, matching the two shapes an appeal can take:
 *
 *  - `UQ_appeals_open_appellant_action` on `(appellant_id, action_id)` WHERE
 *    `status = 'awaiting'` — at most one open appeal per member per appealed
 *    action.
 *  - `UQ_appeals_open_appellant_no_action` on `(appellant_id)` WHERE
 *    `status = 'awaiting' AND action_id IS NULL` — the second index is
 *    necessary because a composite unique index treats NULL `action_id` as
 *    always-distinct, so it would NOT dedupe cold appeals (no resolvable
 *    action). This closes that gap: at most one open cold appeal per member.
 *
 * `submitAppeal` catches the 23505 either raises and returns a 409, so the
 * endpoint is idempotent under a race.
 *
 * The matching class-level `@Index(..., { unique: true, where: ... })`
 * decorators are on the `Appeal` entity so entity metadata and schema stay in
 * sync for any future `migration:generate` diff.
 *
 * `CONCURRENTLY` because `appeals` is a live table — a plain `CREATE UNIQUE
 * INDEX` would hold a lock blocking writes for the build's duration. Mirrors
 * `1785003000000-AddReportsOpenDedupeIndex.ts`. `CREATE INDEX CONCURRENTLY`
 * cannot run inside a transaction block; this migration runs on its own
 * (`transaction = false` + `migrationsTransactionMode: 'each'` in
 * data-source.ts):
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * NOTE: index creation validates against existing data, so it fails loudly if
 * the table already holds duplicate awaiting appeals for a (member, action) —
 * de-duplicate those rows first if so.
 */
export class AddAppealsOpenDedupeIndex1785003500000 implements MigrationInterface {
  name = 'AddAppealsOpenDedupeIndex1785003500000';

  // Runs outside a transaction for `CREATE UNIQUE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). See 1785003000000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_appeals_open_appellant_action" ` +
        `ON "appeals" ("appellant_id", "action_id") ` +
        `WHERE "status" = 'awaiting'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_appeals_open_appellant_no_action" ` +
        `ON "appeals" ("appellant_id") ` +
        `WHERE "status" = 'awaiting' AND "action_id" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "UQ_appeals_open_appellant_no_action"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "UQ_appeals_open_appellant_action"`,
    );
  }
}
