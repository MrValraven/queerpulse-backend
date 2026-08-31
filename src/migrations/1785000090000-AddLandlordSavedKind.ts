import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'landlord' to the saved-item subject-type enum. Only ADDS the value (safe
 * on PostgreSQL 12+); plain `ADD VALUE` matches repo convention. `down()` is a
 * documented no-op (Postgres cannot drop an enum value).
 */
export class AddLandlordSavedKind1785000090000 implements MigrationInterface {
  name = 'AddLandlordSavedKind1785000090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "saved_item_subject_type_enum" ADD VALUE 'landlord'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; 'landlord' is harmless if left.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
