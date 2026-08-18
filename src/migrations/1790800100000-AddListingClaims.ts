// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `listing_claims` — a member's request to take ownership of an EXISTING
 * business listing (`POST /listings/:ref/claim`), reviewed by a moderator
 * (`PATCH /listings/admin/claims/:id`, `ListingClaimsService.review`). On
 * approval the reviewer reassigns the listing's `owner_id` to the claimant, in
 * the same transaction as the claim's status flip — mirrors
 * `JoinRequestsService.review`'s "mint a related record before the status
 * flip, one conditional-claim UPDATE guards against a concurrent double
 * review" shape.
 *
 * `listing_id` deliberately carries NO foreign key to `listings` — mirrors
 * `CreateListingModerationEvents`/`listing_reviews.listing_id`'s identical
 * precedent, so a moderator hard-deleting a listing never cascades away the
 * claim record that documents the request.
 *
 * `claimant_id`/`reviewed_by` both get an `ON DELETE SET NULL` FK to
 * `users(id)` (never CASCADE — see `ListingClaim` entity doc comment): an
 * account-erasure hard-delete nulls the reference out while the claim record
 * survives.
 *
 * The partial unique index `UQ_listing_claims_pending_claimant` on
 * `(listing_id, claimant_id)` `WHERE status = 'pending'` caps a member to one
 * OPEN claim per listing — mirrors `UQ_listing_reviews_reviewer`
 * (`1785600200000-AddListingReviewReviewerDedupeIndex`) /
 * `UQ_community_join_requests_pending`'s identical partial-unique shape.
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddListingClaims1790800100000 implements MigrationInterface {
  name = 'AddListingClaims1790800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "listing_claims_status_enum" AS ENUM('pending', 'approved', 'declined')`,
    );

    await queryRunner.query(`
      CREATE TABLE "listing_claims" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "claimant_id" uuid,
        "note" text,
        "status" "listing_claims_status_enum" NOT NULL DEFAULT 'pending',
        "reviewed_by" uuid,
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_claims" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_listing_claims_listing_id" ON "listing_claims" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_claims_claimant_id" ON "listing_claims" ("claimant_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_claims_reviewed_by" ON "listing_claims" ("reviewed_by")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_claims_status" ON "listing_claims" ("status")`,
    );
    // Partial unique: at most one OPEN (pending) claim per (listing, claimant).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_listing_claims_pending_claimant"
        ON "listing_claims" ("listing_id", "claimant_id")
        WHERE "status" = 'pending'
    `);

    await queryRunner.query(`
      ALTER TABLE "listing_claims" ADD CONSTRAINT "FK_listing_claims_claimant_id"
        FOREIGN KEY ("claimant_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_claims" ADD CONSTRAINT "FK_listing_claims_reviewed_by"
        FOREIGN KEY ("reviewed_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_claims" DROP CONSTRAINT "FK_listing_claims_reviewed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_claims" DROP CONSTRAINT "FK_listing_claims_claimant_id"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_listing_claims_pending_claimant"`);
    await queryRunner.query(`DROP INDEX "IDX_listing_claims_status"`);
    await queryRunner.query(`DROP INDEX "IDX_listing_claims_reviewed_by"`);
    await queryRunner.query(`DROP INDEX "IDX_listing_claims_claimant_id"`);
    await queryRunner.query(`DROP INDEX "IDX_listing_claims_listing_id"`);
    await queryRunner.query(`DROP TABLE "listing_claims"`);
    await queryRunner.query(`DROP TYPE "listing_claims_status_enum"`);
  }
}
