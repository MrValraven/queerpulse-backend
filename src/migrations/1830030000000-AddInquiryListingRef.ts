// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-434. A `listing_ref` on `inquiries`, so a correction to a directory
 * listing carries the listing it is about as data.
 *
 * WHY. "Suggest a correction" opened the Contact page with the topic
 * preselected, and the form sent it as a plain `contact` inquiry whose only
 * trace of the listing was an "About listing QPL-..." line prepended to the
 * body. Staff had to read the ref out of free text. Corrections now arrive as
 * their own `listing_correction` kind (a plain varchar, so the new kind needs
 * no DDL) with the ref in this column, and the admin list links to the
 * listing.
 *
 * BACKFILL. Older corrections carry the topic only as its translated label in
 * `subject` (the EN and PT labels the catalogs have shipped), and the ref only
 * in the note at the start of the body ("About listing {ref}" in EN, "Sobre o
 * anúncio {ref}" in PT). Those rows move to the new kind, with the ref read out
 * of the note when it is there. Any other row is untouched.
 *
 * Purely additive and transactional: one nullable column and one UPDATE. No
 * enum is touched.
 */
export class AddInquiryListingRef1830030000000 implements MigrationInterface {
  name = 'AddInquiryListingRef1830030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inquiries" ADD "listing_ref" character varying`,
    );
    await queryRunner.query(
      `UPDATE "inquiries" SET "kind" = 'listing_correction', "listing_ref" = substring("body" from '^(?:About listing|Sobre o anúncio) ([A-Za-z0-9-]{3,40})') WHERE "kind" = 'contact' AND "subject" IN ('Correction to a directory listing', 'Correção de um anúncio do diretório')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Put the ref back where the old form kept it, at the start of the body,
    // before the column goes. A body that already opens with the note (a
    // backfilled row) keeps it once.
    await queryRunner.query(
      `UPDATE "inquiries" SET "body" = 'About listing ' || "listing_ref" || E'\n\n' || "body" WHERE "kind" = 'listing_correction' AND "listing_ref" IS NOT NULL AND "body" NOT LIKE 'About listing %' AND "body" NOT LIKE 'Sobre o anúncio %'`,
    );
    await queryRunner.query(
      `UPDATE "inquiries" SET "kind" = 'contact' WHERE "kind" = 'listing_correction'`,
    );
    await queryRunner.query(
      `ALTER TABLE "inquiries" DROP COLUMN "listing_ref"`,
    );
  }
}
