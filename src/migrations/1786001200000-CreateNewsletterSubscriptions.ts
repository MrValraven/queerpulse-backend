import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `newsletter_subscriptions` — one row per email address that has used the
 * homepage newsletter form, under double opt-in.
 *
 * A row starts `pending` with an unguessable `confirm_token`; opening the mailed
 * link flips it to `confirmed` and stamps `confirmed_at`. `UQ_newsletter_email`
 * makes a re-subscribe update the existing row rather than duplicate it — which
 * is also what lets the subscribe endpoint stay silent about whether an address
 * was already on the list. `email` is stored lowercased by the service, so the
 * plain UNIQUE constraint is case-safe without needing the `citext` extension.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class CreateNewsletterSubscriptions1786001200000 implements MigrationInterface {
  name = 'CreateNewsletterSubscriptions1786001200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "newsletter_subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "confirm_token" character varying NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "confirmed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_newsletter_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_newsletter_email" UNIQUE ("email")
      )
    `);
    // Confirm-link lookup: GET /newsletter/confirm resolves the row by token.
    await queryRunner.query(
      `CREATE INDEX "IDX_newsletter_confirm_token" ON "newsletter_subscriptions" ("confirm_token")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_newsletter_confirm_token"`);
    await queryRunner.query(`DROP TABLE "newsletter_subscriptions"`);
  }
}
