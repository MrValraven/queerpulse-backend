import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `magazine_issue_published` value to `notifications_type_enum`
 * (CON-05: retire the members' digest).
 *
 * Shipping a magazine issue used to queue one EMAIL per confirmed newsletter
 * subscriber and drain that queue on a once-a-minute cron, which would have
 * started mailing members the moment SMTP was configured. QueerPulse delivers
 * no email, so that whole path is deleted and shipping now writes one in-app
 * notification of this type per active member instead, deep-linking to the
 * issue's own "In this issue" panel.
 *
 * This migration is applied. The app boots with or without it, because the
 * enum column only rejects an unknown label at INSERT time. Shipping an issue
 * with "announce with the issue" on is the path that needs the label, so that
 * path stayed broken until this ran.
 */
export class AddMagazineIssuePublishedNotificationType1794833000000 implements MigrationInterface {
  name = 'AddMagazineIssuePublishedNotificationType1794833000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new value is not USED in this same transaction.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'magazine_issue_published'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Fails loudly rather than
    // reporting a successful revert that undid nothing: a silent no-op would
    // remove the row from the migrations ledger, so the next `migration:run`
    // retries `ADD VALUE` against a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
