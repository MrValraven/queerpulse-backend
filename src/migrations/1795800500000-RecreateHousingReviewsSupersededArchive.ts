// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repairs databases where `housing_reviews_superseded` is missing even though
 * `AddHousingViewingAndReviewUniqueness1793530600000` is recorded as applied.
 *
 * WHAT HAPPENED. `1793530600000` originally created its two unique indexes bare
 * and failed loudly on pre-existing duplicates, leaving resolution to a human.
 * Commit `f867d11` ("fix backend migrations", 2026-08-22) rewrote it in place to
 * collapse duplicates automatically, and that rewrite is what introduced
 * `CREATE TABLE "housing_reviews_superseded"` as the archive the review backfill
 * copies into. Any database that had already applied the PRE-rewrite version
 * carries the ledger row but not the table: TypeORM identifies a migration
 * solely by the `name` on the class, so an edited body never re-runs.
 *
 * That is the state of the local development database, and the evidence is
 * unambiguous rather than inferred: `UQ_housing_viewings_open` and
 * `UQ_housing_reviews_listing_author` both exist, the `migrations` row for
 * `AddHousingViewingAndReviewUniqueness1793530600000` exists, and the archive
 * table does not. In the post-rewrite body the `CREATE TABLE` sits BETWEEN those
 * two indexes inside one transaction, so a run of that version could not have
 * produced this schema. Only the pre-rewrite version could.
 *
 * The symptom is `AddHousingReviewsSupersededErasureForeignKeys1795801000000`
 * aborting with `relation "housing_reviews_superseded" does not exist`, which
 * under `migrationsTransactionMode: 'each'` also blocks the 23 migrations queued
 * behind it.
 *
 * WHY A NEW MIGRATION AND NOT AN EDIT. Editing `1795801000000` to tolerate the
 * missing table would leave the drift in place: `1793530600000.down()` restores
 * `housing_reviews` by `INSERT ... SELECT` out of this archive and then drops
 * it, so on a drifted database that rollback fails the same way. The schema, not
 * the consumer, is what is wrong. Re-editing `1793530600000` itself would fix
 * nothing either, for the same reason its first edit did not: it is already in
 * the ledger everywhere.
 *
 * WHY `IF NOT EXISTS` IS CORRECT HERE, against the general rule in CLAUDE.md.
 * That rule forbids reaching for `IF NOT EXISTS` to silence an "already exists"
 * failure, because it writes a ledger row for work already recorded and hides
 * drift. This migration is the opposite case: the drift is diagnosed, and the
 * guard exists so the SAME migration is a no-op on the databases that are
 * already correct (production, CI, any from-scratch `migration:run`, all of
 * which ran the post-rewrite body) and a repair on the ones that are not.
 * Shape drift is not a risk to hide: exactly one migration in history creates
 * this table, so wherever it exists it has this definition.
 *
 * THE TABLE IS EXPECTED TO BE EMPTY ON A REPAIRED DATABASE, and that is correct
 * rather than lossy. The pre-rewrite version had no backfill at all: it created
 * `UQ_housing_reviews_listing_author` bare and would have ABORTED had any
 * duplicate reviews existed. It succeeded, so there were none, so a
 * post-rewrite run would have archived zero rows.
 *
 * DEFINITION COPIED VERBATIM from `1793530600000`, including the `superseded_at`
 * default and the reuse of `housing_review_author_role_enum`. No FKs and no
 * extra indexes: `1795801000000`, which runs immediately after this, is the
 * migration that adds both.
 *
 * TIMESTAMP. `1795800500000` sits between `AddMissingUserForeignKeysForErasure`
 * (`1795800000000`, applied) and the migration that needs the table
 * (`1795801000000`, pending). TypeORM orders pending migrations by timestamp, so
 * this runs first.
 */
export class RecreateHousingReviewsSupersededArchive1795800500000 implements MigrationInterface {
  name = 'RecreateHousingReviewsSupersededArchive1795800500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "housing_reviews_superseded" (
        "id" uuid NOT NULL,
        "viewing_id" uuid NOT NULL,
        "listing_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "subject_id" uuid NOT NULL,
        "author_role" "housing_review_author_role_enum" NOT NULL,
        "rating" integer NOT NULL,
        "text" character varying(1000) NOT NULL,
        "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "superseded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_housing_reviews_superseded" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. This migration does not OWN the table: on every
    // correct database it created nothing, and `1793530600000.down()` is what
    // drops it. Dropping it here would delete the archive out from under that
    // rollback on the very databases this repaired, and would destroy archived
    // member-authored review text on any database where it did hold rows.
  }
}
