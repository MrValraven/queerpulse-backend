// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the Performance audit's admin-roster indexing gap (finding B16,
 * `references/database-and-indexing.md`): `AdminMembersService.list`
 * (`admin-members.service.ts:139-150`) always ends with
 * `.orderBy('profile.firstName', 'ASC').skip().take(ADMIN_MEMBERS_PAGE_SIZE)`,
 * and its `filter === 'new'` branch adds `profile.joinedAt >= :since`
 * (the last-7-days window). Neither `first_name` nor `joined_at` carries an
 * index on `profiles`, so every roster page today pays a `Seq Scan` +
 * in-memory `Sort` over the whole table (name order), or a `Seq Scan` (the
 * `joinedAt` filter) that only gets more expensive as the member base grows.
 * `verified` is deliberately NOT indexed here — a boolean column is too
 * low-cardinality for a b-tree to meaningfully narrow a scan.
 *
 * `profiles` already carries production traffic (prior `CONCURRENTLY`
 * migrations exist against it, e.g. `AddSearchTrgmAndTagsIndexes1785700100000`),
 * so both indexes are built `CREATE INDEX CONCURRENTLY`, never a plain
 * blocking `CREATE INDEX`. `CREATE INDEX CONCURRENTLY` cannot run inside a
 * transaction block ("`CREATE INDEX`", PostgreSQL manual) — `transaction =
 * false` opts this migration out (honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddAdminMemberIndexes1787600200000 implements MigrationInterface {
  name = 'AddAdminMemberIndexes1787600200000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_first_name" ` +
        `ON "profiles" ("first_name")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_joined_at" ` +
        `ON "profiles" ("joined_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_profiles_joined_at"`);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_first_name"`,
    );
  }
}
