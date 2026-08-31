import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The enum labels behind LOC-19, "close the four approval queues that go
 * nowhere". Four member-submitted things reached the database and stopped: a
 * reading-group proposal, a listing submitted into a vetted housing group, a
 * suggested landlord directory entry, and a request for an introduction to a
 * landlord. Each was decided by staff and the member was never told.
 *
 * Four `notifications_type_enum` labels, one per queue, each covering every
 * outcome of that queue with a `decision` field in the payload (the shape
 * `volunteer_application_decided` already uses) rather than a label per
 * outcome:
 *  - `reading_group_proposal_decided`
 *  - `group_listing_decided`
 *  - `landlord_suggestion_decided`
 *  - `landlord_intro_request_decided`
 *
 * Plus one `group_listings_status_enum` label, `declined`. That enum had only
 * `review`, `question` and `live`, so there was no way to record "this listing
 * will not be published" at all: a moderator could either leave it in `review`
 * forever or hide it, and `hidden` is the POST-publication norm takedown, a
 * different decision that must stay distinct.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here
 * (e.g. `AddReportFiledNotificationTypes1794600000000`): `ALTER TYPE ... ADD
 * VALUE` must be COMMITTED before any statement may use the new label, so this
 * opts out of the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`). It adds
 * labels and nothing else, so the sibling
 * `1794741000000-AddApprovalQueueDecisionAudit` carries the column work in a
 * normal transaction.
 *
 * `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddApprovalQueueNotificationTypes1794740000000 implements MigrationInterface {
  name = 'AddApprovalQueueNotificationTypes1794740000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'reading_group_proposal_decided'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'group_listing_decided'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'landlord_suggestion_decided'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'landlord_intro_request_decided'`,
    );
    await queryRunner.query(
      `ALTER TYPE "group_listings_status_enum" ADD VALUE IF NOT EXISTS 'declined'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added labels
    // are harmless. Fails loudly rather than reporting a successful revert that
    // undid nothing, since a silent no-op removes the ledger row and the next
    // `migration:run` retries `ADD VALUE` against labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
