import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listing_co_managers` — day-to-day management access to a business directory
 * listing for someone who is not its owner.
 *
 * WHY. `listings.owner_id` holds exactly one member, so a venue run by two
 * people had no way to share its page: the second person used the first
 * person's login or had no access at all. This table is the same answer
 * communities already gave (`AddCommunityCoOwnerRole1793920000000`) applied to
 * listings, with the same thing left unchanged and worth stating plainly: the
 * single-owner constraint on `listings.owner_id` is UNTOUCHED. That column
 * still holds one accountable owner of record, a co-manager is never written
 * into it, and becoming the owner is still an explicit ownership transfer
 * (`ListingClaimsService.review`) — which, on approval, revokes every row in
 * this table for that listing.
 *
 * INVITED, NEVER DIRECT-ADDED. A row starts at `invited` and grants nothing
 * until the invited member sets it to `active` themselves.
 *
 * COLUMNS AND THEIR FKs.
 *  - `listing_id` cascades from `listings`, following
 *    `listing_enquiries.listing_id`: an access grant to a listing that no
 *    longer exists is not worth keeping. This deliberately differs from
 *    `listing_moderation_events.listing_id`, which has no FK precisely so the
 *    audit of a deletion survives it — an audit row and an access row want
 *    opposite things.
 *  - `user_id` cascades from `users`. A `SET NULL` orphan would be a row
 *    granting access to nobody while still consuming one of the listing's
 *    seats.
 *  - `invited_by_user_id` is `SET NULL`, mirroring
 *    `listing_moderation_events.actor_id`: who acted stays referentially
 *    honest, and the seat outlives the erasure of the owner who created it,
 *    since listings change hands.
 *
 * ONE ROW PER MEMBER PER LISTING is enforced here, not in application code.
 * `UQ_listing_co_managers_listing_user` is a plain (non-partial) unique
 * constraint, which is stronger than the partial index `listing_reviews` uses
 * for its one-review-per-member rule: there is no predicate to get wrong. A
 * member who declined or was removed and is invited again reuses their row
 * rather than adding a second one.
 *
 * INDEXES. `(listing_id)` serves the roster read and the per-listing seat
 * count; the unique constraint's own index is `(listing_id, user_id)` and would
 * cover a listing-scoped scan too, but the plain one is kept for the ordered
 * roster read that does not name a user. `(user_id, status)` serves both
 * member-side reads, which each filter on status: "which listings do I
 * co-manage" (`active`, feeding `GET /listings/mine`) and "what am I invited
 * to" (`invited`).
 *
 * TRANSACTIONAL. One CREATE TYPE, one CREATE TABLE, two CREATE INDEXes and
 * three ADD CONSTRAINTs, every one of them against objects created in this same
 * transaction, so nothing waits on a lock another session holds and no
 * `CONCURRENTLY` two-phase split is needed. The enum values this feature adds
 * to EXISTING types live in the separate, deliberately non-transactional
 * `AddListingCoManagerEnumValues1794530000000`.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class CreateListingCoManagers1794520000000 implements MigrationInterface {
  name = 'CreateListingCoManagers1794520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "listing_co_managers_status_enum" AS ENUM (
        'invited', 'active', 'declined', 'revoked', 'left'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "listing_co_managers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "invited_by_user_id" uuid,
        "status" "listing_co_managers_status_enum" NOT NULL DEFAULT 'invited',
        "invited_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "accepted_at" TIMESTAMP WITH TIME ZONE,
        "ended_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_co_managers" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_listing_co_managers_listing_user"
          UNIQUE ("listing_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_co_managers_listing_id"
         ON "listing_co_managers" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_co_managers_user_id_status"
         ON "listing_co_managers" ("user_id", "status")`,
    );
    await queryRunner.query(`
      ALTER TABLE "listing_co_managers"
        ADD CONSTRAINT "FK_listing_co_managers_listing_id"
        FOREIGN KEY ("listing_id") REFERENCES "listings"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_co_managers"
        ADD CONSTRAINT "FK_listing_co_managers_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_co_managers"
        ADD CONSTRAINT "FK_listing_co_managers_invited_by_user_id"
        FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_co_managers" DROP CONSTRAINT "FK_listing_co_managers_invited_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_co_managers" DROP CONSTRAINT "FK_listing_co_managers_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_co_managers" DROP CONSTRAINT "FK_listing_co_managers_listing_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_co_managers_user_id_status"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_listing_co_managers_listing_id"`);
    await queryRunner.query(`DROP TABLE "listing_co_managers"`);
    await queryRunner.query(`DROP TYPE "listing_co_managers_status_enum"`);
  }
}
