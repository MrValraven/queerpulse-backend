// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The QueerPulse Team mailbox: adds `official` to `identities_kind_enum`.
 *
 * Only ADDs the value. Postgres refuses to use a new enum label inside the
 * transaction that added it, so the CHECK constraints and the identity row
 * that reference `'official'` live in the next migration,
 * `AddOfficialMailboxIdentity1827900100000`, which runs in its own
 * transaction (`migrationsTransactionMode: 'each'`, see `data-source.ts`).
 * Safe on PostgreSQL 12+, the same shape as
 * `AddVideoAndAudioCreatorKinds1827800050000`.
 */
export class AddOfficialIdentityKind1827900000000 implements MigrationInterface {
  name = 'AddOfficialIdentityKind1827900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "identities_kind_enum" ADD VALUE 'official'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Failing loudly keeps the
    // ledger honest; a silent no-op would make the next run retry `ADD VALUE`
    // and error on a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
