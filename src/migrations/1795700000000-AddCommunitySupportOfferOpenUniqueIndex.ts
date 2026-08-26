// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "A community may hold only one UNANSWERED offer of support at a time" is the
 * invariant `AdminCommunitySupportService.create` documents and, until this
 * file, the only thing enforcing it was an `exists(...)` read followed by a
 * `save(...)` on a separate connection round trip. Nothing stood between the
 * two: no transaction, no lock, no constraint. An admin double-clicking the
 * health modal's button, or two staff members reaching for the same struggling
 * room in the same second, both read `false` and both inserted. The community's
 * moderators then got two notifications for one offer, two governance-log
 * entries went into a permanent record, and the mod-tools pane showed an
 * `openCount` of 2 for a number the code says can only ever be 1.
 *
 * A PARTIAL unique index is the right shape rather than a plain one: the
 * uniqueness only holds while `status = 'new'`. Once the community answers,
 * `status` moves to 'acknowledged' or 'declined', the row leaves the index,
 * and a fresh offer is allowed. That is exactly the product rule, expressed
 * where two concurrent writers cannot both win.
 *
 * The service keeps its pre-check as the fast path (it produces the friendly
 * 409 without touching the table's write path) and now also catches the unique
 * violation this index raises, translating it into the same
 * `ConflictException`. The pre-check answers the common case; the index
 * answers the race.
 *
 * TRANSACTIONAL. `community_support_offers` was created empty by
 * `1795660000000-CreateCommunitySupportOffers.ts`, which has not been run yet
 * either, so this index builds on no rows and needs no
 * `CREATE INDEX CONCURRENTLY`. `IF NOT EXISTS` on the create so a re-run after
 * a partial failure is harmless.
 */
export class AddCommunitySupportOfferOpenUniqueIndex1795700000000 implements MigrationInterface {
  name = 'AddCommunitySupportOfferOpenUniqueIndex1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Should the table already hold duplicate open offers when this runs (only
    // possible if the feature shipped before this file did), keep the oldest
    // open offer per community and mark the rest answered-by-nobody, because a
    // unique index cannot be created over duplicates. `declined` is the honest
    // resting state for an offer that was never really made twice.
    await queryRunner.query(`
      UPDATE "community_support_offers" AS duplicate
      SET "status" = 'declined', "updated_at" = now()
      WHERE duplicate."status" = 'new'
        AND EXISTS (
          SELECT 1 FROM "community_support_offers" AS kept
          WHERE kept."community_id" = duplicate."community_id"
            AND kept."status" = 'new'
            AND (kept."created_at", kept."id") < (duplicate."created_at", duplicate."id")
        )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_community_support_offers_open"
        ON "community_support_offers" ("community_id")
        WHERE "status" = 'new'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_community_support_offers_open"`,
    );
    // The duplicate-collapsing UPDATE above is not reversible: once an offer
    // has been moved to 'declined' there is no record of which rows were
    // rewritten, and guessing would resurrect offers a community may already
    // have seen answered. Dropping the index is the whole of the down path.
  }
}
