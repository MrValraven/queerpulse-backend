// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-113 — adds `magazine_pitch.returned_at`, the instant a pitch came back
 * into the editor inbox because the piece commissioned from it was deleted.
 *
 * Deleting a mis-commissioned piece used to strand its pitch at
 * `status = 'commissioned'` forever. `listPitches` returns only `waiting` and
 * `maybe`, so the pitch disappeared from the inbox permanently: it could not be
 * re-triaged, could not be commissioned again, and nothing anywhere recorded
 * that it had ever existed. `deletePiece` now returns the pitch to `waiting`
 * and stamps this column, so the inbox can mark it as a returning pitch instead
 * of an editor being surprised by a row they thought was already dealt with.
 *
 * Nullable with no default: NULL means "never came back", which is every pitch
 * written before this and the overwhelming majority afterwards.
 *
 * The status move itself needs no DDL: `magazine_pitch.status` is a plain
 * `varchar` string union (the module's idiom, no Postgres `CREATE TYPE`), and
 * `waiting` is a value it already holds.
 */
export class AddMagazinePitchReturnedAt1806300000000 implements MigrationInterface {
  name = 'AddMagazinePitchReturnedAt1806300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_pitch" ADD COLUMN "returned_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_pitch" DROP COLUMN "returned_at"`,
    );
  }
}
