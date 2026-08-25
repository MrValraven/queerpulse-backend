import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.services`: what a business sells and what it costs.
 *
 * Price was a single band from free to three euro signs. For a bar or a
 * gallery that is enough. For a barber, a therapist, a tattoo studio or a
 * clinic, "what does it cost" is the last question before booking, and "€€"
 * does not answer it. Someone deciding whether they can afford a first therapy
 * session should not have to send an email to find out.
 *
 * Each entry is `{ name, price, note }`, validated by
 * `ListingServiceOfferingDto` (name and price required, note optional; capped
 * at `MAX_LISTING_SERVICES` entries). `price` is deliberately FREE TEXT rather
 * than a number or a range: real pricing here is "from 25 EUR", "sliding
 * scale, 30-60 EUR", "first session free", "by quote", and a numeric column
 * would have forced every one of those into a lie or an empty cell.
 *
 * The existing `price` band column is UNCHANGED and stays the at-a-glance
 * signal a card shows. This list is the detail behind it, on the detail page.
 *
 * Stored as jsonb next to `hours_exceptions` (same column type, same access
 * pattern: read whole, written whole) rather than as a child table. Nothing
 * queries or joins across individual services; the frontend renders the whole
 * set it already fetched for the detail page.
 *
 * Fully transactional: one `ADD COLUMN` with a constant default. On PostgreSQL
 * 11+ that is a catalog-only change with no table rewrite, so existing rows
 * read as `[]` without being touched.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingServices1794220000000 implements MigrationInterface {
  name = 'AddListingServices1794220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "services" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "services"`);
  }
}
