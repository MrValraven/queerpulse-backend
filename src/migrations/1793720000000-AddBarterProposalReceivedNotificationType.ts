import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing the barter bell:
 * `barter_proposal_received`, sent to a swap listing's owner when a member
 * proposes against it (`BarterService.createProposal`). Until now a proposal
 * reached the owner only as a DM, so the bell showed nothing.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddCommunityTagRequestResolvedNotificationType`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 *
 * Depends on `AddBarter1793710000000` (the tables this notification type
 * refers to) but does not touch it — kept in a separate, later-timestamped
 * migration because it must run non-transactionally while the table migration
 * is safely transactional.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddBarterProposalReceivedNotificationType1793720000000
  implements MigrationInterface
{
  name = 'AddBarterProposalReceivedNotificationType1793720000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'barter_proposal_received'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added label is harmless.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
