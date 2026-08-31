import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LOC-05 — makes the nominations already in the table readable by the review
 * workflow `AddSafeSpaceReviewWorkflow1794730000000` just added.
 *
 * Runs as its own migration rather than inside that one because it is DATA, not
 * schema: it has to be reviewable and revertible on its own terms, and it reads
 * `listings` (a table the DDL migration deliberately does not touch).
 *
 * THREE BACKFILLS.
 *
 * 1. `listing_id` from the member-typed `listing_ref`, where that value matches
 *    a real listing's `ref` or `slug`. A nomination that already pointed at a
 *    business in the directory is a nomination that can start collecting
 *    independent member visits immediately, and re-typing that link by hand for
 *    every historical row would be pointless. A `listing_ref` that matches
 *    nothing is left alone: it is a member's guess, and inventing a link from it
 *    is exactly the kind of unearned certainty this whole item is fixing.
 *
 * 2. Nominations that were already `approved` or `rejected` are stamped
 *    `acknowledged_at` and `decided_at` from `created_at`, with a
 *    `decision_reason` that says plainly no reason was recorded. Without this
 *    they would read as never acknowledged, so the queue would report a 48-hour
 *    breach on every nomination the team actually dealt with, and `reopen`
 *    (which requires a decision to undo) could not touch them.
 *
 * 3. Nothing is written to `pending` rows. A nomination nobody has answered is
 *    exactly what it says it is, breach and all. Silently marking the backlog
 *    acknowledged would be the platform marking its own homework.
 */
export class BackfillSafeSpaceNominationWorkflow1794731000000 implements MigrationInterface {
  name = 'BackfillSafeSpaceNominationWorkflow1794731000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "safe_space_nominations" AS nomination
         SET "listing_id" = listing."id"
        FROM "listings" AS listing
       WHERE nomination."listing_id" IS NULL
         AND nomination."listing_ref" IS NOT NULL
         AND (listing."ref" = nomination."listing_ref"
              OR listing."slug" = nomination."listing_ref")
    `);

    await queryRunner.query(`
      UPDATE "safe_space_nominations"
         SET "acknowledged_at" = COALESCE("acknowledged_at", "created_at"),
             "decided_at" = COALESCE("decided_at", "created_at"),
             "decision_reason" = COALESCE(
               "decision_reason",
               'Decided before the safe-space review workflow existed. No reason was recorded at the time.'
             )
       WHERE "status" IN ('approved', 'rejected')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverses only what this migration wrote. The placeholder reason is the
    // marker: a row carrying it was stamped here and nowhere else, so clearing
    // exactly those rows cannot erase a decision a moderator later recorded
    // properly.
    await queryRunner.query(`
      UPDATE "safe_space_nominations"
         SET "acknowledged_at" = NULL,
             "decided_at" = NULL,
             "decision_reason" = NULL
       WHERE "decision_reason" =
             'Decided before the safe-space review workflow existed. No reason was recorded at the time.'
    `);
    await queryRunner.query(`
      UPDATE "safe_space_nominations" AS nomination
         SET "listing_id" = NULL
        FROM "listings" AS listing
       WHERE nomination."listing_id" = listing."id"
         AND nomination."listing_ref" IS NOT NULL
         AND (listing."ref" = nomination."listing_ref"
              OR listing."slug" = nomination."listing_ref")
    `);
  }
}
