import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.queer_owned_verifier` / `_re_verified_at` / `_basis` /
 * `_expires_at`: provenance and an expiry for the queer-owned badge.
 *
 * `queer_owned_verified` was a bare boolean. The safe-space badge sitting
 * beside it on the same page already carried `safe_space_verifier`,
 * `safe_space_tier` and `safe_space_re_verified_at`, all of them visible, so a
 * reader saw two badges that looked equally authoritative and were backed by
 * very different evidence. One could be checked; the other could only be
 * believed.
 *
 * These four columns are named and shaped after the `safe_space_*` set on
 * purpose, so the two read as siblings: who confirmed it, when they last
 * confirmed it, and what the confirmation rested on.
 *
 * `queer_owned_expires_at` is the new part. A business can quietly change
 * hands, and a confirmation granted once should not still be speaking for it
 * years later. Past this date the badge stops reading as verified on every
 * response (`isQueerOwnedCurrentlyVerified` in `listing-response.ts`) while
 * every column here stays exactly where it is: an expired badge is one that
 * needs looking at again, never one that was never granted. Withdrawal by a
 * moderator is the separate act that clears these columns.
 *
 * Backfill, for the rows that already carry `queer_owned_verified = true`:
 *  - `queer_owned_verifier` = 'QueerPulse moderation'. We do not know which
 *    moderator granted these, and inventing a name would be worse than naming
 *    the team that did.
 *  - `queer_owned_re_verified_at` = `updated_at::date`, the best available
 *    evidence of when the flag was last touched.
 *  - `queer_owned_basis` records plainly that the grant pre-dates provenance
 *    being captured, so nobody reads a blank as "no evidence was required".
 *  - `queer_owned_expires_at` = CURRENT_DATE + 12 months, deliberately NOT
 *    24 months from `re_verified_at`. Dating the expiry from an old
 *    `updated_at` would have made some existing badges expire the instant this
 *    ships, silently stripping live badges as a side effect of a schema
 *    change. A grace window from the day the migration runs means no badge
 *    disappears on deploy, and every legacy grant is nonetheless re-confirmed
 *    within a year. New grants get the standard
 *    `QUEER_OWNED_VERIFICATION_VALIDITY_MONTHS` window from their own
 *    confirmation date.
 *
 * Rows that were never verified are left entirely alone: nulls and empty
 * strings there mean "no grant", which is exactly right.
 *
 * Fully transactional: one multi-column `ADD COLUMN` (constant defaults,
 * catalog-only on PostgreSQL 11+) plus one `UPDATE` over the verified rows.
 * No index is added: the badge is read per-listing off rows the query already
 * fetched, and the existing `IDX_listings_queer_owned_verified` still serves
 * the only predicate anything filters on.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingQueerOwnedProvenance1794240000000 implements MigrationInterface {
  name = 'AddListingQueerOwnedProvenance1794240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings"
         ADD "queer_owned_verifier" character varying NOT NULL DEFAULT '',
         ADD "queer_owned_re_verified_at" date,
         ADD "queer_owned_basis" text NOT NULL DEFAULT '',
         ADD "queer_owned_expires_at" date`,
    );
    await queryRunner.query(
      `UPDATE "listings"
         SET "queer_owned_verifier" = 'QueerPulse moderation',
             "queer_owned_re_verified_at" = "updated_at"::date,
             "queer_owned_basis" = 'Confirmed before provenance was recorded. Re-confirm and note the evidence at the next review.',
             "queer_owned_expires_at" = CURRENT_DATE + INTERVAL '12 months'
       WHERE "queer_owned_verified" = true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings"
         DROP COLUMN "queer_owned_expires_at",
         DROP COLUMN "queer_owned_basis",
         DROP COLUMN "queer_owned_re_verified_at",
         DROP COLUMN "queer_owned_verifier"`,
    );
  }
}
