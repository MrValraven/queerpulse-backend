import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Perf fix: `DirectoryService`'s "saved by N members" count
 * (`directory.service.ts` — `savedItems.count({ where: { subjectType,
 * subjectId } })`) filters `saved_item` on `(subject_type, subject_id)` with
 * no `user_id` in the predicate at all. The table's only existing indexes are
 * `IDX_saved_item_user_id` (leading `user_id`, useless here — see "Multicolumn
 * Indexes", PostgreSQL manual, on leading-column requirements) and the unique
 * `UQ_saved_item_subject` on `(user_id, subject_type, subject_id)`, whose
 * leading column is likewise `user_id`, so neither can serve this query and
 * every directory-detail read does a sequential scan over `saved_item`. This
 * adds a dedicated composite index with `(subject_type, subject_id)` as the
 * leading pair to match the query exactly.
 *
 * The matching `@Index('IDX_saved_item_subject', ['subjectType',
 * 'subjectId'])` decorator is on the `SavedItem` entity itself
 * (`saved/entities/saved-item.entity.ts`, class-level — mirroring this repo's
 * other composite-index decorators, e.g. `ForumPost`'s
 * `IDX_forum_post_thread_id_parent_post_id`) so entity metadata and schema
 * stay in sync for any future `migration:generate` diff.
 *
 * `CONCURRENTLY` because `saved_item` already carries production traffic
 * (bookmarks accrue from day one of the feature) — a plain `CREATE INDEX`
 * would hold a lock that blocks writes for the build's duration. Mirrors
 * `1785001700000-AddListingsStatusIndex.ts` and
 * `1785001600000-AddCommunityPostsFeedOrderIndex.ts`, the repo's convention
 * for adding an index to an already-populated table (as opposed to a
 * brand-new table's indexes, created inline as plain `CREATE INDEX` alongside
 * `CREATE TABLE`). `CREATE INDEX CONCURRENTLY` cannot run inside a
 * transaction block ("`CREATE INDEX`", PostgreSQL manual); run this migration
 * on its own:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddSavedItemSubjectIndex1785002600000 implements MigrationInterface {
  name = 'AddSavedItemSubjectIndex1785002600000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). Re-runnability comes
  // from the deploy preflight dropping invalid indexes, not `IF NOT EXISTS`
  // (forbidden here — hides drift). See 1785001500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_saved_item_subject" ` +
        `ON "saved_item" ("subject_type", "subject_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_saved_item_subject"`);
  }
}
