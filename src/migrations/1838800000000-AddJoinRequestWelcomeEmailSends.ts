// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records the welcome emails a reviewer sent from the join-request queue
 * (`POST /admin/join-requests/:id/invite/email`), so the queue can show
 * whether one already went out and when.
 *
 * `welcome_email_send_count` counts only the sends Resend accepted, and a
 * reissue of the invite keeps it. The send path also folds it into the
 * Resend idempotency key, so a deliberate resend gets a fresh key while two
 * concurrent clicks share one. `welcome_email_last_sent_at` is the moment of
 * the latest counted send. Both are staff-only.
 *
 * Every earlier row starts at 0 and NULL: nothing recorded a send before this
 * column existed. The constant default makes the count column a catalog
 * change only.
 */
export class AddJoinRequestWelcomeEmailSends1838800000000 implements MigrationInterface {
  name = 'AddJoinRequestWelcomeEmailSends1838800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "welcome_email_send_count" integer NOT NULL DEFAULT 0,
        ADD "welcome_email_last_sent_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "welcome_email_last_sent_at",
        DROP COLUMN "welcome_email_send_count"
    `);
  }
}
