// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stops DRAFT personas from squatting a global handle. The unique partial index
 * `UQ_subprofiles_handle` previously covered `WHERE "handle" IS NOT NULL`, so a
 * member could park a desired handle on a never-published draft and reserve it
 * against the whole namespace indefinitely. This narrows the predicate to
 * `WHERE "handle" IS NOT NULL AND "status" = 'published'`: published personas
 * still enforce global handle uniqueness, but a draft can hold a desired handle
 * without reserving it — two drafts may name the same handle, and only the
 * FIRST to publish claims it (publish-time `HandlesService.isTaken`/`rename`
 * still enforces uniqueness across published personas + main usernames, so
 * nothing regresses there).
 *
 * Rebuilt with the same name so the entity's `@Index('UQ_subprofiles_handle')`
 * still matches (no `migration:generate` drift). `subprofiles` carries
 * production traffic, so the index is dropped + recreated `CONCURRENTLY` rather
 * than with a blocking DDL — `CREATE/DROP INDEX CONCURRENTLY` cannot run inside
 * a transaction block, so `transaction = false` opts this migration out
 * (honored because `data-source.ts` sets `migrationsTransactionMode: 'each'`).
 * During the brief drop→create window the DB-level guard is absent, but the
 * `handles` registry remains the authoritative publish-time uniqueness check,
 * so no duplicate published handle can slip through. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class NarrowSubprofileHandleUniqueIndexToPublished1787700100000 implements MigrationInterface {
  name = 'NarrowSubprofileHandleUniqueIndexToPublished1787700100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "UQ_subprofiles_handle"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_subprofiles_handle" ` +
        `ON "subprofiles" ("handle") ` +
        `WHERE "handle" IS NOT NULL AND "status" = 'published'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "UQ_subprofiles_handle"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_subprofiles_handle" ` +
        `ON "subprofiles" ("handle") ` +
        `WHERE "handle" IS NOT NULL`,
    );
  }
}
