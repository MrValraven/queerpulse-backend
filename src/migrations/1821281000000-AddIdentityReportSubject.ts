// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `identity` joins `reports_subject_type_enum`.
 *
 * A customer talking to a business through its mailbox had no
 * conversation-level way to report it. `member` would need the handle of the
 * human who replied, which the customer never holds and must never learn, and
 * the `listing`, `company` and `subprofile` subjects are addressed by slug or
 * persona id and record no thread. The new subject is addressed by the
 * identity's uuid and filed only from the customer's own direct thread with
 * it; `ReportsService.create` carries the gate and the snapshot.
 *
 * Reason codes are code-side (`reports.reason_code` is a free `varchar`), so
 * `SUBJECT_REASONS` in `reason-catalogue.ts` is the only other change this
 * value forces; that map is a total `Record<ReportSubjectType, ...>`. The
 * frontend mirror in `queerpulse/src/features/safety/reportReasons.ts` is a
 * total `Record` for the same reason. Follows
 * `AddVolunteeringReportSubjectAndAnonymousFloodKey1813000000000`.
 *
 * ## Transaction mode
 *
 * Plain transactional. `ADD VALUE` is safe inside the migration transaction
 * on PostgreSQL 12+ so long as nothing in the SAME transaction USES the new
 * label, and this migration is that one statement alone.
 *
 * Unguarded on purpose. An `IF NOT EXISTS` would let a second run succeed
 * against a label the ledger already records, and that hides the ledger drift
 * the repository's migration guidance says to diagnose.
 */
export class AddIdentityReportSubject1821281000000 implements MigrationInterface {
  name = 'AddIdentityReportSubject1821281000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'identity'`,
    );
  }

  public async down(): Promise<void> {
    // Fails loudly and reverts nothing. Postgres has no `ALTER TYPE ... DROP
    // VALUE`, so this label is irreversible, and reporting a successful revert
    // would remove the ledger row while the label stays. Mirrors
    // `AddVolunteeringReportSubjectAndAnonymousFloodKey1813000000000`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
