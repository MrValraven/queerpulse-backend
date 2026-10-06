// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `group_listing` joins `reports_subject_type_enum` (PRD-443).
 *
 * A room shared inside a housing group (`group_listings`) had no report
 * control at all: `housing` names a member listing by slug in a different
 * table, so a reader worried about a group room had nowhere to send it. The
 * new subject is addressed by the room's uuid. A moderator's `hide_content` /
 * `remove_content` on it writes a `content_moderation` row that
 * `HousingGroupsService.listVisibleListings` filters on.
 *
 * Reason codes are code-side (`reports.reason_code` is a free `varchar`), so
 * `SUBJECT_REASONS` in `reason-catalogue.ts` is the only other change this
 * value forces. Follows `AddIdentityReportSubject1821281000000`.
 *
 * ## Transaction mode
 *
 * Plain transactional. `ADD VALUE` is safe inside the migration transaction
 * on PostgreSQL 12+ so long as nothing in the SAME transaction USES the new
 * label, and this migration is that one statement alone.
 *
 * Unguarded on purpose, as its predecessor explains: a second run against a
 * label the ledger already records should fail and surface the drift.
 */
export class AddGroupListingReportSubject1829500200000 implements MigrationInterface {
  name = 'AddGroupListingReportSubject1829500200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'group_listing'`,
    );
  }

  public async down(): Promise<void> {
    // Fails loudly and reverts nothing. Postgres has no `ALTER TYPE ... DROP
    // VALUE`, so this label is irreversible. Mirrors
    // `AddIdentityReportSubject1821281000000`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
