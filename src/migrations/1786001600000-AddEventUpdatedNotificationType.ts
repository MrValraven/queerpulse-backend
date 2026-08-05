// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing event-change notifications:
 * `event_updated`, fanned out to an event's RSVP'd + invited members when the
 * organizer makes a MATERIAL edit (start time or location) so nobody shows up at
 * the wrong time or place (P2-7).
 *
 * TWO-PHASE / NON-TRANSACTIONAL. `ALTER TYPE ... ADD VALUE` is committed on its
 * own here — the migration opts out of the wrapping transaction
 * (`transaction = false`, honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`), for the same family of reasons the
 * `CREATE INDEX CONCURRENTLY` migrations do: an enum value must be COMMITTED
 * before any statement may USE it, so adding and using it in one transaction is
 * unsafe. Keeping the ADD VALUE in its own committed step means the code that
 * writes `EventUpdated` rows (a separate deploy) always sees a durable enum
 * label. `IF NOT EXISTS` keeps the step re-run-safe. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * `down()` is a documented no-op — Postgres has no `ALTER TYPE ... DROP VALUE`;
 * the added label is harmless if left in place.
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddEventUpdatedNotificationType1786001600000
  implements MigrationInterface
{
  name = 'AddEventUpdatedNotificationType1786001600000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_updated'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added value is harmless if
    // left in place.
  }
}
