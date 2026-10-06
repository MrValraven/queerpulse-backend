import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-452. A priority flag on `inquiries`, so a safety concern sent through
 * the Contact form sorts to the top of the admin triage list while it waits.
 *
 * WHY. The Contact page tells someone who feels unsafe that their message
 * goes to the team's priority queue and is read first. Until now the inbox
 * held no severity at all: a safety message waited in date order beside press
 * requests and feedback. `InquiriesService.create` now sets the flag from the
 * topic the form sends, and the list orders waiting priority rows first.
 *
 * BACKFILL. Older rows carry the topic only as its translated label in
 * `subject`, so the two labels the catalogs have shipped for the safety topic
 * (EN and PT) mark the existing safety messages. Any other row stays false.
 *
 * Purely additive and transactional: one column with a constant default and
 * one UPDATE. No enum is touched.
 */
export class AddInquiryPriority1828730000000 implements MigrationInterface {
  name = 'AddInquiryPriority1828730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inquiries" ADD "is_priority" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `UPDATE "inquiries" SET "is_priority" = true WHERE "kind" = 'contact' AND "subject" IN ('Safety concern', 'Preocupação de segurança')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inquiries" DROP COLUMN "is_priority"`,
    );
  }
}
