import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.affirming_baseline_accepted_at`: the LGBTQ+ affirming baseline
 * every business listing agrees to in order to appear at all.
 *
 * Whether a business here is welcoming was inferred from a `badge` value and a
 * scatter of amenity tags, which left it looking like an attribute some
 * listings happen to have. The housing side of this platform already settled
 * the principle (`AffirmingPledgeService`, `users.affirming_pledge_accepted_at`,
 * and `1793530400000-BackfillHousingListingAffirmingBaseline`): being LGBTQ+
 * affirming is a MANDATORY universal baseline, not an optional flag and not a
 * filter members opt into. A directory whose default is "unknown, check the
 * tags" makes its members do safety research the directory exists to have done
 * already.
 *
 * What is agreed to is a commitment about the business's own conduct: to
 * welcome and serve LGBTQ+ people, and to deal with it when someone in the
 * space does not. It is a promise to treat people decently. It grants nobody
 * permission to turn anyone away over who they are, it must never be described
 * or rendered as though it did, and it is not related to identity-based
 * exclusion in any direction.
 *
 * One nullable timestamp rather than a boolean plus a date: a single column
 * answers both "did they agree" and "when", and two columns could disagree.
 * `CreateListingDto.affirmingBaselineAccepted` is `@Equals(true)`, so
 * submission requires acceptance, and the instant is stamped server-side in
 * `ListingsService.create` so it cannot be backdated by a client.
 *
 * Backfill: every existing listing is stamped from its own `created_at`. Every
 * one of them was submitted to a directory whose whole premise is this
 * baseline, so recording them as never-agreed would be the inaccurate answer,
 * and would break every live listing's response. Their `created_at` is the
 * honest instant to attribute it to: that is when they joined the directory.
 *
 * Deliberately left NULLABLE rather than `NOT NULL` after the backfill. A hard
 * `NOT NULL` would push the enforcement into the schema, where an ops insert or
 * a seed could satisfy it with any value at all; the real gate is the required
 * DTO field, and a null here should read as "this row bypassed the submission
 * path" rather than being impossible to observe.
 *
 * Fully transactional: one `ADD COLUMN` (nullable, no default, catalog-only)
 * plus one `UPDATE`.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingAffirmingBaseline1794230000000 implements MigrationInterface {
  name = 'AddListingAffirmingBaseline1794230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "affirming_baseline_accepted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "listings"
         SET "affirming_baseline_accepted_at" = "created_at"
       WHERE "affirming_baseline_accepted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "affirming_baseline_accepted_at"`,
    );
  }
}
