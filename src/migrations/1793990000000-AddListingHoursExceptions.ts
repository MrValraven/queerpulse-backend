import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.hours_exceptions`: per-date overrides of the weekly opening-hours
 * grid.
 *
 * Hours were a 7-day grid plus a free-text note, so a public holiday could
 * only ever be described in prose that no "open now" calculation can read. A
 * wrong closing time on Christmas Eve is how people stop trusting a directory,
 * and one wrong answer costs more trust than ten right ones earn.
 *
 * Each entry is `{ date, open, intervals, note }`, validated by
 * `ListingHoursExceptionDto`, which extends `ListingDayHoursDto` so a date
 * carries the very same interval rules the seven weekday entries do (a closed
 * day has no intervals; an open day has 1..2 non-overlapping, non-zero-length
 * `HH:MM` intervals, overnight allowed). `date` is a `YYYY-MM-DD` calendar
 * date in the listing's own timezone, checked for real existence, and no two
 * entries may name the same date. The array is capped at 60 entries.
 *
 * Stored as jsonb next to `hours` (same column type, same access pattern: read
 * whole, written whole) rather than as a child table. Nothing queries or joins
 * across individual exception dates; the frontend does the "open now"
 * arithmetic from the whole set it already fetched for the detail page.
 *
 * Fully transactional: one `ADD COLUMN` with a constant default. On PostgreSQL
 * 11+ that is a catalog-only change with no table rewrite, so existing rows
 * read as `[]` without being touched.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingHoursExceptions1793990000000 implements MigrationInterface {
  name = 'AddListingHoursExceptions1793990000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "hours_exceptions" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "hours_exceptions"`,
    );
  }
}
