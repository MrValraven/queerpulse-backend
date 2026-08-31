import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `unsubscribed_at` to `newsletter_subscriptions` (CNT-19): the entity's
 * `status` column already accepted `'unsubscribed'` as a value, but nothing
 * ever set it and there was no watermark for when it happened. `GET
 * /newsletter/unsubscribe` (see `NewsletterService.unsubscribe`) is the new
 * self-serve path that transitions a row to `unsubscribed` and stamps this
 * column, mirroring `confirmed_at`'s shape (nullable, set once, on the row it
 * describes).
 *
 * No new index: the endpoint resolves the row by `confirm_token`, which
 * `IDX_newsletter_confirm_token` (`CreateNewsletterSubscriptions`) already
 * covers — the same token doubles as the unsubscribe key, so no second lookup
 * path exists to index.
 */
export class AddNewsletterUnsubscribe1792000000000 implements MigrationInterface {
  name = 'AddNewsletterUnsubscribe1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "newsletter_subscriptions" ADD "unsubscribed_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "newsletter_subscriptions" DROP COLUMN "unsubscribed_at"`,
    );
  }
}
