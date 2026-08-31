import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes the directory/search hot path. `SubprofilesService.directory()` and
 * `searchByText()` both filter on `(link_visibility, status, visibility)` with
 * `handle IS NOT NULL` + `removed_at IS NULL`, then order by `display_name`.
 * The existing `IDX_subprofiles_directory (kind, status, visibility)` does not
 * cover the linkVisibility/handle/removed predicate nor the `display_name`
 * sort, so a browse pays a filter + in-memory sort over the table. This partial
 * composite matches exactly that predicate and sort key, and — being partial —
 * excludes every draft/nested/removed row from the index entirely.
 *
 * `subprofiles` carries production traffic, so the index is built
 * `CREATE INDEX CONCURRENTLY`, never a blocking `CREATE INDEX`. `CONCURRENTLY`
 * cannot run inside a transaction block, so `transaction = false` opts this
 * migration out (honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddSubprofileDirectoryBrowseIndex1787700200000 implements MigrationInterface {
  name = 'AddSubprofileDirectoryBrowseIndex1787700200000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_subprofiles_directory_browse" ` +
        `ON "subprofiles" ("link_visibility", "status", "visibility", "display_name") ` +
        `WHERE "handle" IS NOT NULL AND "removed_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_subprofiles_directory_browse"`,
    );
  }
}
