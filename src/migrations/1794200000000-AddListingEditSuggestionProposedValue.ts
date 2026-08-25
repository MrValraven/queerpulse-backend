// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listing_edit_suggestions.proposed_value`: the exact replacement value a
 * member offers alongside their prose when they suggest an edit to a business
 * listing.
 *
 * Before this column a suggestion could only say that something was wrong;
 * a moderator then read the prose and retyped the corrected value by hand. The
 * common case is a member who knows the exact new phone number or the exact new
 * closing time, so carrying that value on the row turns accepting into a single
 * click.
 *
 * NULLABLE with no default, deliberately:
 *
 * 1. Every row filed before this column existed carries prose alone, and prose
 *    alone stays a first-class submission. "The hours are wrong and I do not
 *    know what they are now" is a useful report, so `message` remains the
 *    required half and this is the optional one.
 * 2. `null` and empty string must not both mean "absent". The DTO trims and
 *    maps a blank value to absent before it reaches here, so `null` is the one
 *    representation of "no value proposed".
 *
 * `text` rather than a per-field width: which `listings` column a value lands
 * on depends on the row's `field` (`phone` is capped at 60, `address` at 300),
 * and those bounds are enforced by the shared class-validator rules in
 * `accepted-suggestion-value.ts` on both the submit and the accept path. A
 * narrower column here would duplicate one of those bounds and contradict the
 * others.
 *
 * Timestamp chosen well clear of the 1793.9xx band several concurrent branches
 * are filling, so ordering stays unambiguous without renumbering anything.
 *
 * Adding a nullable column with no default is a metadata-only `ALTER TABLE` in
 * Postgres: no table rewrite, no backfill.
 */
export class AddListingEditSuggestionProposedValue1794200000000 implements MigrationInterface {
  name = 'AddListingEditSuggestionProposedValue1794200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_edit_suggestions" ADD "proposed_value" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_edit_suggestions" DROP COLUMN "proposed_value"`,
    );
  }
}
