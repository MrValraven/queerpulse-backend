import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing the "suggest a tag"
 * feedback loop: `community_tag_request_resolved`, sent to the owner/mod who
 * submitted a tag request when an admin marks it resolved
 * (`AdminCommunityTagRequestsService.resolve`). System-driven — no actor and
 * no preference toggle, mirroring `ConcernUpdate`/`ListingEditSuggestionAccepted`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddConcernUpdateNotificationType`): `ALTER TYPE ...
 * ADD VALUE` must be COMMITTED before any statement may use the new label, so
 * this opts out of the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`).
 * `IF NOT EXISTS` keeps it re-run-safe. `down()` is a no-op: Postgres has no
 * `ALTER TYPE ... DROP VALUE`, and the added label is harmless if left.
 *
 * Depends on `AddCommunityTagRequests1793400000000` (the table this
 * notification type refers to) but does not touch it — kept in a separate,
 * later-timestamped migration because it must run non-transactionally while
 * the table migration is safely transactional.
 */
export class AddCommunityTagRequestResolvedNotificationType1793400100000 implements MigrationInterface {
  name = 'AddCommunityTagRequestResolvedNotificationType1793400100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_tag_request_resolved'`,
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
