// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfills the empty `city` and `timezone` every member-created listing was
 * written with (LOC-15).
 *
 * `createListingInput` stored `city: dto.city ?? ''` and
 * `timezone: dto.timezone ?? ''`, and the listings wizard sent neither, so every
 * listing a member created carries two empty strings. The write path now
 * resolves both (`listing-city.ts`), which fixes new rows and leaves the
 * existing ones to this migration.
 *
 * Why it matters beyond tidiness:
 *  - The empty city was masked at the single render site by
 *    `listing.city || 'Lisbon'`, so it LOOKED correct while every query against
 *    the column matched nothing.
 *  - An empty `timezone` gives `openStatus` no venue-local clock, so the whole
 *    opening-hours feature (LOC-11) answers "unknown" for exactly the listings
 *    members create themselves. Filling it is what switches those listings on.
 *
 * Only blank values are touched, so a row that already carries a real city or a
 * deliberate non-default timezone (the admin bulk-import path can set one) is
 * left exactly as it is. That also makes the migration idempotent.
 *
 * `down()` is deliberately a no-op. The previous state of these rows was an
 * empty string standing in for "nobody ever asked", which is indistinguishable
 * from a row this migration filled and one a member later confirmed as Lisbon.
 * Re-emptying them would blank correct data to restore a bug, so reverting this
 * migration reverts the code and leaves the repaired values in place.
 */
export class BackfillListingCityAndTimezone1794800000000 implements MigrationInterface {
  name = 'BackfillListingCityAndTimezone1794800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "listings" SET "city" = 'Lisbon' WHERE "city" IS NULL OR btrim("city") = ''`,
    );
    await queryRunner.query(
      `UPDATE "listings" SET "timezone" = 'Europe/Lisbon' WHERE "timezone" IS NULL OR btrim("timezone") = ''`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally empty; see the note above.
  }
}
