import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A durable, per-subscriber ledger for the members' digest (BE-MSG-14).
 *
 * Shipping a magazine issue used to mail the entire confirmed list INLINE and
 * in series, inside the publish request, stamping one `digest_sent_at` on the
 * issue only after the last send. That meant the request blocked for
 * `subscribers x SMTP round trip` (the mailer allows 8s to connect and 8s per
 * socket operation, so up to 16s each against a degraded host), and any
 * interruption part-way through left the issue looking unsent, so the next ship
 * re-mailed everyone who had already received it. Nothing recorded who had
 * actually been mailed.
 *
 * Two tables replace that:
 *
 *  - `newsletter_digest_batches` snapshots the rendered mailing ONCE per issue.
 *    `issue_id` is UNIQUE, which is what makes queueing idempotent across the
 *    re-ships an issue legitimately gets as later pieces clear their publish
 *    gate. No FK to `magazine_issues`: the newsletter module owns this table
 *    and does not otherwise depend on the magazine schema.
 *  - `newsletter_digest_sends` is one row per (batch, subscriber), claimed and
 *    stamped individually by a cron. `attempts` is incremented by the claim
 *    itself, before the send is attempted, so a crash mid-send burns the
 *    attempt instead of leaving a row to be retried forever; `claimed_at`
 *    doubles as a lease so a drain slower than the cron interval cannot have
 *    its in-flight rows re-claimed underneath it.
 *
 * The FK to `newsletter_subscriptions` cascades: a deleted subscriber has
 * nothing left to mail, and the ledger row is not history worth keeping without
 * the address it points at.
 */
export class AddNewsletterDigestLedger1793610000000 implements MigrationInterface {
  name = 'AddNewsletterDigestLedger1793610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
    // One mailing per issue, ever. The queue path upserts on this key, so a
    // re-ship resolves to the SAME batch instead of creating a second one.
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
    // The drain's claim predicate, exactly. Partial on `sent_at IS NULL` so the
    // index stays the size of the OUTSTANDING queue rather than of every digest
    // ever mailed.
    await queryRunner.query(
      `CREATE INDEX "IDX_newsletter_digest_sends_pending" ON "newsletter_digest_sends" ("claimed_at") WHERE "sent_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "newsletter_digest_sends"`);
    await queryRunner.query(`DROP TABLE "newsletter_digest_batches"`);
  }
}
