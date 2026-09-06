// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the five `notifications_type_enum` values behind the housing lifecycle
 * (PRD-240, PRD-242, PRD-244), every one of which closes a state change that
 * previously happened in total silence:
 *
 * - `housing_viewing_requested` — a member asked to view a home. Until this,
 *   `HousingViewingsService` held no `NotificationsService` at all, so a lister
 *   learned about it only by opening `/local/housing/viewings`, which is
 *   reachable from one small text link on the listing page.
 * - `housing_viewing_decided` — the other side accepted, declined or proposed a
 *   different time. `payload.decision` carries which. Note the recipient is NOT
 *   a fixed side: each of `accept`, `propose` and `decline` is guarded by
 *   `if (viewing.proposedBy === role) throw`, so the acting party is whoever did
 *   not make the proposal on the table, which is the requester once the lister
 *   has counter-proposed.
 * - `housing_viewing_cancelled` — one side called it off; the other is about to
 *   travel to a viewing that is not happening.
 * - `housing_join_decided` — a co-op or vetted housing-group application was
 *   accepted or declined. `payload.kind` distinguishes the two surfaces. The
 *   community tier has carried `join_request_approved`/`_declined` for this
 *   since launch; housing had no equivalent.
 * - `housing_listing_expiring` — a listing lapses in a week. Every other expiry
 *   signal on the platform is post-mortem.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE` migrations
 * (see `AddConcernUpdateNotificationType1788600000000`, the template this
 * follows, and `AddMagazinePieceWriterNotificationTypes1806200000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use the
 * new label, so this opts out of the wrapping transaction (`transaction =
 * false`, honoured because `data-source.ts` sets `migrationsTransactionMode:
 * 'each'`). Nothing here uses the new labels, but the opt-out is kept because
 * the newest migration in the repo keeps it and a mixed convention is how the
 * next author gets it wrong. `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddHousingLifecycleNotificationTypes1817000000000
  implements MigrationInterface
{
  name = 'AddHousingLifecycleNotificationTypes1817000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'housing_viewing_requested'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'housing_viewing_decided'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'housing_viewing_cancelled'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'housing_join_decided'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'housing_listing_expiring'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres has no `ALTER TYPE ... DROP VALUE`, and the added
    // values are harmless if left. Fails loudly rather than reporting a
    // successful revert that undid nothing: a silent no-op removes the row from
    // the migrations ledger, so the next `migration:run` retries `ADD VALUE` on
    // labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
