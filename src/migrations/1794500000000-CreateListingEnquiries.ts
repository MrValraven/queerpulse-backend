import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listing_enquiries` — the link between a directory listing and the 1:1
 * conversation a member's private enquiry was delivered into.
 *
 * IT HOLDS NO MESSAGE TEXT, and that is the single most important thing about
 * the shape. Messaging owns message storage; the enquiry itself is an ordinary
 * row in `messages`, written through the same
 * `MessagingService.deliverEnquiry` seam housing enquiries, job replies and
 * barter proposals already use. Copying the member's words into a second table
 * would mean an edit, a delete, or a "delete for me" in the thread leaves a
 * stale copy of them attached to a business listing forever. What this table
 * records is a fact messaging has no reason to know (which LISTING the thread
 * started from) and the listing has no other way to remember.
 *
 * COLUMNS AND THEIR FKs.
 *  - `listing_id` cascades from `listings`, following
 *    `listing_reviews.listing_id`: with the listing gone there is nothing left
 *    for this row to be about.
 *  - `sender_id` cascades from `users`. Unlike a review or a public question,
 *    this is not content other people read; it is one member's private outreach
 *    record, so an account erasure takes it rather than leaving a `SET NULL`
 *    orphan pointing at a conversation that has also gone.
 *  - `owner_id` has NO foreign key on purpose. It is a SNAPSHOT of who the
 *    listing belonged to when the message was sent, and listings change hands
 *    (`ListingClaimsService.review`), so it must not be re-pointed or cascaded
 *    by anything that happens to the current owner. Mirrors
 *    `listing_claims.listing_id`'s no-FK precedent.
 *  - `conversation_id` has NO foreign key either, because it points across a
 *    domain boundary into messaging and this module must never be able to
 *    cascade anything into a conversation. Conversations are not hard-deleted
 *    (a member "deleting" one only stamps their own `cleared_at`), so the
 *    reference stays resolvable.
 *
 * INDEXES. `(listing_id, sender_id)` serves the "have you already written to
 * this business?" read and the per-listing daily cap, which are the same
 * lookup, and leads with `listing_id` so it also covers a listing-scoped scan.
 * `(sender_id, created_at)` serves the across-all-listings daily cap and the
 * erasure sweep. Both caps are counted rather than left to the HTTP throttle
 * for the reason `ListingEnquiriesService` documents: the abuse shape that
 * matters is a slow trickle no 60-second window can see.
 *
 * Fully transactional: one CREATE TABLE, two CREATE INDEXes and two ADD
 * CONSTRAINTs, all against a table created in the same transaction, so nothing
 * takes a lock another session is waiting on and no `CONCURRENTLY` two-phase
 * split is needed.
 */
export class CreateListingEnquiries1794500000000 implements MigrationInterface {
  name = 'CreateListingEnquiries1794500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "listing_enquiries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "sender_id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_enquiries" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_enquiries_listing_id_sender_id"
         ON "listing_enquiries" ("listing_id", "sender_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_enquiries_sender_id_created_at"
         ON "listing_enquiries" ("sender_id", "created_at")`,
    );
    await queryRunner.query(`
      ALTER TABLE "listing_enquiries"
        ADD CONSTRAINT "FK_listing_enquiries_listing_id"
        FOREIGN KEY ("listing_id") REFERENCES "listings"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_enquiries"
        ADD CONSTRAINT "FK_listing_enquiries_sender_id"
        FOREIGN KEY ("sender_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_enquiries" DROP CONSTRAINT "FK_listing_enquiries_sender_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_enquiries" DROP CONSTRAINT "FK_listing_enquiries_listing_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_enquiries_sender_id_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_enquiries_listing_id_sender_id"`,
    );
    await queryRunner.query(`DROP TABLE "listing_enquiries"`);
  }
}
