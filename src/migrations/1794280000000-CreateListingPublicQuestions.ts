import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listing_public_questions` — "ask the owner, in public" on a business
 * listing detail page.
 *
 * A member asks, the owner answers, and BOTH stay on the page for the next
 * person with the same question. The questions a queer person actually needs
 * answered before walking into a place (is the entrance step-free, is there a
 * gender-neutral bathroom, do I need to book, is the upstairs room accessible)
 * are asked repeatedly, answered privately, and read once. This table is what
 * makes the answer outlive the conversation.
 *
 * A SEPARATE TABLE FROM `listing_questions`, deliberately, and this is the
 * single most important thing to understand about it. That table is the
 * MODERATOR-to-submitter channel used while a listing is still under review: a
 * moderator asks for missing evidence, the submitter answers, and the pair is
 * visible only inside the admin drawer (`GET /admin/listings/:ref/history`).
 * Author, audience, lifecycle and visibility are all different. Overloading one
 * table would have put a "but which kind is this" predicate on every read of
 * both, and the first read that forgot it would publish a moderator's private
 * compliance question on a public marketing page.
 *
 * COLUMNS.
 *  - `asker_name` is a snapshot taken at ask time, exactly as
 *    `listing_reviews.reviewer_name` is, so a question reads consistently after
 *    the asker renames themselves. The asker's slug and avatar are resolved
 *    LIVE from their profile on every read, so a changed slug never links to a
 *    dead profile. The identity exposed is precisely what a review already
 *    exposes for its author and nothing more.
 *  - `asker_id` and `answered_by_id` are nullable with `ON DELETE SET NULL`,
 *    matching `listing_reviews.reviewer_id`: an account erasure unlinks the
 *    name, it does not delete public content other readers depend on.
 *  - `answered_by_id` is stored rather than inferred from the listing's current
 *    owner, because listings change hands (`ListingClaimsService`) and an
 *    answer is a record of who actually spoke.
 *  - `is_answered_by_moderator` is stamped at answer time rather than derived
 *    later from `answered_by_id = listings.owner_id`. That derivation silently
 *    changes its mind: a moderator's answer on an unowned listing would start
 *    rendering as the business's own words the day an owner is attached to it.
 *
 * `listing_id` carries a real FK with `ON DELETE CASCADE`, following
 * `listing_reviews.listing_id` (`FK_listing_reviews_listing_id`) rather than
 * the no-FK convention `listing_questions`/`listing_moderation_events` take.
 * Those two are moderation records that are meaningfully readable after the
 * listing is gone; a public Q&A block is not — it is part of the page, and it
 * should leave with the page.
 *
 * INDEX. One composite `(listing_id, created_at DESC)`, which serves the public
 * read whole: the filter and the ordering are the same index scan, and there is
 * no separate `listing_id`-only index because this one leads with it. The
 * `asker_id` index backs the per-member rate-limit count in
 * `DirectoryService.askQuestion` (see below) and the erasure `SET NULL` sweep.
 *
 * RATE LIMITING is partly this index's job. The ask endpoint carries an HTTP
 * throttle for bursts, but the abuse shape that actually matters on a queer
 * venue's public page is a slow, sustained campaign that no 60-second window
 * ever sees, so the service also counts a member's recent questions out of this
 * table before accepting another. Both caps are documented at the call site.
 *
 * Fully transactional: one CREATE TABLE, one CREATE INDEX and two ADD
 * CONSTRAINTs, all against a table created in the same transaction, so no lock
 * is taken on anything another session is reading and no `CONCURRENTLY`
 * two-phase split is needed.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class CreateListingPublicQuestions1794280000000 implements MigrationInterface {
  name = 'CreateListingPublicQuestions1794280000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "listing_public_questions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "asker_id" uuid,
        "asker_name" character varying NOT NULL,
        "body" text NOT NULL,
        "answer" text,
        "answered_at" TIMESTAMP WITH TIME ZONE,
        "answered_by_id" uuid,
        "is_answered_by_moderator" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_public_questions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_public_questions_listing_id_created_at"
         ON "listing_public_questions" ("listing_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_public_questions_asker_id"
         ON "listing_public_questions" ("asker_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "listing_public_questions"
        ADD CONSTRAINT "FK_listing_public_questions_listing_id"
        FOREIGN KEY ("listing_id") REFERENCES "listings"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_public_questions"
        ADD CONSTRAINT "FK_listing_public_questions_asker_id"
        FOREIGN KEY ("asker_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_public_questions"
        ADD CONSTRAINT "FK_listing_public_questions_answered_by_id"
        FOREIGN KEY ("answered_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_public_questions" DROP CONSTRAINT "FK_listing_public_questions_answered_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_public_questions" DROP CONSTRAINT "FK_listing_public_questions_asker_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_public_questions" DROP CONSTRAINT "FK_listing_public_questions_listing_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_public_questions_asker_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_public_questions_listing_id_created_at"`,
    );
    await queryRunner.query(`DROP TABLE "listing_public_questions"`);
  }
}
