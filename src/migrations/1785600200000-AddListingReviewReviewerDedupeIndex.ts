import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integrity fix (audit P1-5): `listing_reviews` had NO unique guard behind
 * `DirectoryService.addReview` — the submit path was a plain
 * `create` + `save` with no dedupe check, so a single account could POST the
 * same business's review endpoint repeatedly, piling duplicate rows that skew
 * the listing's aggregated star rating and inflate its standing in the Safe
 * Spaces feed.
 *
 * Adds a PARTIAL unique index on `(listing_id, reviewer_id)` scoped to
 * `WHERE reviewer_id IS NOT NULL`: at most one member-authored review per
 * (member, listing). The partial `WHERE` is deliberate — seeded/imported
 * reviews carry a NULL `reviewer_id` (see `ListingReview.reviewerId`), and
 * several of those can legitimately coexist on one listing; a plain unique
 * index would still allow them (NULLs are distinct in Postgres) but scoping the
 * index states the intent and keeps it off the seed rows entirely. Mirrors
 * `1785003000000-AddReportsOpenDedupeIndex.ts` and
 * `1785003500000-AddAppealsOpenDedupeIndex.ts`.
 *
 * `DirectoryService.addReview` now catches the 23505 this raises
 * (`isUniqueViolation`, `UQ_listing_reviews_reviewer`) and returns a clean 409
 * `ConflictException` instead of a 500, so a double-submit is idempotent from
 * the caller's side.
 *
 * The matching class-level `@Index('UQ_listing_reviews_reviewer', ['listingId',
 * 'reviewerId'], { unique: true, where: '"reviewer_id" IS NOT NULL' })`
 * decorator is on the `ListingReview` entity so entity metadata and schema stay
 * in sync for any future `migration:generate` diff.
 *
 * `CONCURRENTLY` because `listing_reviews` already carries production traffic —
 * a plain `CREATE UNIQUE INDEX` would hold a lock that blocks writes for the
 * build's duration. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
 * block; this migration runs on its own (`transaction = false` +
 * `migrationsTransactionMode: 'each'` in data-source.ts):
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * NOTE: index creation validates against existing data, so it FAILS LOUDLY if
 * production already holds duplicate member reviews for a (listing, reviewer) —
 * de-duplicate those rows first if so.
 */
export class AddListingReviewReviewerDedupeIndex1785600200000 implements MigrationInterface {
  name = 'AddListingReviewReviewerDedupeIndex1785600200000';

  // Runs outside a transaction for `CREATE UNIQUE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). See 1785003000000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_listing_reviews_reviewer" ` +
        `ON "listing_reviews" ("listing_id", "reviewer_id") ` +
        `WHERE "reviewer_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "UQ_listing_reviews_reviewer"`,
    );
  }
}
