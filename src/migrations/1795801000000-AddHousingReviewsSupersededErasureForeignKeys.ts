// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-34: brings the `housing_reviews_superseded` archive inside account
 * erasure.
 *
 * WHY. `AddHousingViewingAndReviewUniqueness1793530600000` introduced a unique
 * index on (listing_id, author_id, author_role) and, rather than discard the
 * duplicate reviews that already existed, moved them into
 * `housing_reviews_superseded` with every column intact: the member-written
 * `text`, the `rating`, and both `author_id` and `subject_id`. That table has
 * no entity, no repository, no FK and no reader anywhere in `src` (a grep for
 * the table name outside that one migration returns nothing), so it is invisible
 * to `AccountDeletionProcessorService.eraseAccount`, which erases a member by
 * deleting their `users` row and relying entirely on cascades. A member who
 * erases their account today leaves their archived review text behind forever,
 * still naming them as the author and naming the other member as the subject.
 *
 * OPTION (b), DROP THE TABLE, WAS REJECTED, and not on sentiment. The archive is
 * the sole backing store for that migration's `down()`: it restores
 * `housing_reviews` by `INSERT ... SELECT` straight out of
 * `housing_reviews_superseded` and only then drops it. Dropping the table here
 * would leave a shipped migration whose `down()` silently restores zero rows,
 * turning a reversible step into quiet data loss the next time anybody unwinds
 * that batch. The comment there is explicit that "the duplicate data is
 * preserved rather than discarded". A one-time archive with a live reader in
 * `down()` is not dead weight, so option (a) it is: keep the rows, and make
 * erasure reach them.
 *
 * ON DELETE CASCADE ON BOTH COLUMNS.
 *
 *  - `author_id`: the live `housing_reviews.author_id` was flipped to
 *    `ON DELETE SET NULL` by `SetNullContentAuthorFksOnUserErasure1794610000000`
 *    because "a review the next tenant reads" outlives its author. That
 *    reasoning does not carry over. These rows are the SUPERSEDED duplicates:
 *    they were removed from the live table precisely so nobody would read them,
 *    and no code path can surface them. Keeping the text with a nulled byline
 *    would preserve a member's writing for no reader, and unlike the live table
 *    this archive also holds `subject_id`, so the pair stays re-identifiable.
 *    The column is `NOT NULL` here in any case, so `SET NULL` would require
 *    dropping that first.
 *  - `subject_id`: the same migration deliberately left
 *    `housing_reviews.subject_id` cascading, calling it "a review ABOUT the
 *    erased member, which erasure should take with it". The archive copy is the
 *    same fact, so it gets the same rule.
 *
 * The cost is honest and worth stating: after an erasure, that migration's
 * `down()` can no longer restore the erased member's superseded reviews. That
 * is the correct order of priorities. Erasure is irreversible by design, and a
 * schema rollback recovering rows a member asked to have destroyed would be the
 * worse outcome.
 *
 * ORPHANS FIRST, since `ADD CONSTRAINT` validates existing rows and a failure
 * here aborts the whole Railway `preDeployCommand` batch. Any row already
 * naming a deleted user is exactly the residue this migration exists to remove,
 * and nothing can read it.
 *
 * TWO NEW INDEXES. The table was created with a primary key on `id` and nothing
 * else, so a cascade delete would sequential-scan it once per erased user, on
 * each of the two columns. Neither index duplicates anything.
 *
 * Purely transactional: `DELETE`, plain `CREATE INDEX` (never `CONCURRENTLY`)
 * and `ALTER TABLE ... ADD CONSTRAINT`, so this runs inside its own migration
 * transaction under `migrationsTransactionMode: 'each'`. The table is a bounded,
 * one-time archive of whatever duplicates existed the day it ran, so the write
 * lock is measured in milliseconds.
 *
 * NOT COVERED HERE: the member data export
 * (`src/account/data-export-contributors.ts`) still has no contributor for
 * housing reviews of any kind, live or archived. That is a separate gap,
 * reported rather than fixed, since a contributor is a class plus a module
 * registration rather than a line.
 */
export class AddHousingReviewsSupersededErasureForeignKeys1795801000000 implements MigrationInterface {
  name = 'AddHousingReviewsSupersededErasureForeignKeys1795801000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "housing_reviews_superseded"
        WHERE NOT EXISTS (
          SELECT 1 FROM "users"
           WHERE "users"."id" = "housing_reviews_superseded"."author_id"
        )
           OR NOT EXISTS (
          SELECT 1 FROM "users"
           WHERE "users"."id" = "housing_reviews_superseded"."subject_id"
        )`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_housing_reviews_superseded_author_id"
         ON "housing_reviews_superseded" ("author_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_reviews_superseded_subject_id"
         ON "housing_reviews_superseded" ("subject_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "housing_reviews_superseded"
        ADD CONSTRAINT "FK_housing_reviews_superseded_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_reviews_superseded"
        ADD CONSTRAINT "FK_housing_reviews_superseded_subject_id"
        FOREIGN KEY ("subject_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_reviews_superseded" DROP CONSTRAINT "FK_housing_reviews_superseded_subject_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_reviews_superseded" DROP CONSTRAINT "FK_housing_reviews_superseded_author_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_housing_reviews_superseded_subject_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_housing_reviews_superseded_author_id"`,
    );
  }
}
