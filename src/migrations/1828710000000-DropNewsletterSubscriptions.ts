import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the email newsletter tables (ENG-477). QueerPulse sends no email, the
 * subscribe endpoint stored addresses with no purpose, and the module that
 * owned them is gone. Magazine issues reach members through the in-app
 * "Nesta edicao" panel and a notification, which read none of these tables.
 *
 * DESTRUCTIVE: every stored address and unsubscribe/confirm token is deleted.
 * The digest ledger tables go first because `newsletter_digest_sends` holds a
 * foreign key to `newsletter_subscriptions`.
 *
 * `down()` recreates the three tables empty, with the shape the three
 * originating migrations left (`CreateNewsletterSubscriptions`,
 * `AddNewsletterUnsubscribe`, `AddNewsletterDigestLedger`). The rows are not
 * recoverable.
 */
export class DropNewsletterSubscriptions1828710000000 implements MigrationInterface {
  name = 'DropNewsletterSubscriptions1828710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "newsletter_digest_sends"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "newsletter_digest_batches"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "newsletter_subscriptions"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "newsletter_subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "confirm_token" character varying NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "confirmed_at" TIMESTAMP WITH TIME ZONE,
        "unsubscribed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_newsletter_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_newsletter_email" UNIQUE ("email")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_newsletter_confirm_token" ON "newsletter_subscriptions" ("confirm_token")`,
    );

    await queryRunner.query(`
      CREATE TABLE "newsletter_digest_batches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "issue_id" uuid NOT NULL,
        "issue_number" character varying(64) NOT NULL,
        "issue_title" text NOT NULL,
        "items" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_newsletter_digest_batches" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_newsletter_digest_batches_issue" ON "newsletter_digest_batches" ("issue_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "newsletter_digest_sends" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "batch_id" uuid NOT NULL,
        "subscription_id" uuid NOT NULL,
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "attempts" integer NOT NULL DEFAULT 0,
        "claimed_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_newsletter_digest_sends" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_newsletter_digest_sends_batch_subscription"
          UNIQUE ("batch_id", "subscription_id"),
        CONSTRAINT "FK_newsletter_digest_sends_batch" FOREIGN KEY ("batch_id")
          REFERENCES "newsletter_digest_batches" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_newsletter_digest_sends_subscription" FOREIGN KEY ("subscription_id")
          REFERENCES "newsletter_subscriptions" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_newsletter_digest_sends_pending" ON "newsletter_digest_sends" ("claimed_at") WHERE "sent_at" IS NULL`,
    );
  }
}
