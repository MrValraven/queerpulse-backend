// DO NOT RUN — authored for review only; the maintainer runs migrations.
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
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`. The app BOOTS
 * without it (the enum column only rejects the new label at INSERT time), but
 * shipping an issue with "announce with the issue" on will fail until it runs.
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
