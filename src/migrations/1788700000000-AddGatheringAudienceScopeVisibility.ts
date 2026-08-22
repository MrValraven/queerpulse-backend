// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the three new `events_visibility_enum` values the gathering
 * audience-scope design introduces (2026-08-13 design doc):
 * `network` (strict 1st-degree), `extended_network` (2nd-degree, link-only —
 * see `EventsService.scopedVisibilityWhere`), and `community` (members of the
 * event's own community).
 *
 * Postgres enums are not auto-altered (`synchronize` is off), so each value is
 * added explicitly with `ALTER TYPE ... ADD VALUE` — mirroring
 * `AddAstrologerKind1787700300000` / `AddPoleDancerKind1787700600000`, the
 * repo's established pattern for this exact class of DDL. This migration only
 * ADDS values and never USES one in the same transaction (no INSERT/UPDATE
 * referencing them here), which is the one combination Postgres forbids
 * inside a transaction block ("ALTER TYPE ... ADD VALUE cannot run inside a
 * transaction block that has also used the new value" — PostgreSQL manual).
 * That means, unlike the `CREATE INDEX CONCURRENTLY` migrations, this one does
 * NOT need to opt out of the transaction (`transaction = false`) even though
 * `data-source.ts` sets `migrationsTransactionMode: 'each'` — plain `ADD
 * VALUE` (no `IF NOT EXISTS`) run-of-the-mill inside its own per-migration
 * transaction is safe on PostgreSQL 12+.
 *
 * `down()` now throws instead of pretending to revert: Postgres has no `ALTER TYPE ... DROP
 * VALUE`, and the added values are harmless if left in place once no rows
 * reference them.
 */
export class AddGatheringAudienceScopeVisibility1788700000000 implements MigrationInterface {
  name = 'AddGatheringAudienceScopeVisibility1788700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "events_visibility_enum" ADD VALUE 'network'`,
    );
    await queryRunner.query(
      `ALTER TYPE "events_visibility_enum" ADD VALUE 'extended_network'`,
    );
    await queryRunner.query(
      `ALTER TYPE "events_visibility_enum" ADD VALUE 'community'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop enum values. Leaving the new tiers in place
    // is harmless once no rows reference them.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
