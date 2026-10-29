// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The music family: adds `music` to `events_gathering_family_enum`.
 *
 * This only adds the label. Postgres refuses to use a new enum label inside
 * the transaction that added it, so the re-file of the five music formats
 * lives in the next migration, `RefileMusicFormatEvents1838200100000`, which
 * runs in its own transaction (`migrationsTransactionMode: 'each'`, see
 * `data-source.ts`). Safe on PostgreSQL 12+, the same shape as
 * `AddOfficialIdentityKind1827900000000`.
 */
export class AddMusicGatheringFamily1838200000000 implements MigrationInterface {
  name = 'AddMusicGatheringFamily1838200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "events_gathering_family_enum" ADD VALUE 'music'`,
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
