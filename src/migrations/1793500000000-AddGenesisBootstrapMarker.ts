import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `genesis_bootstrap` — a one-row, one-way "genesis consumed" marker.
 *
 * The genesis founder-bootstrap endpoints (`GenesisService`) used to gate
 * re-triggering purely on live DB state: minting closes once any real member
 * exists, and claiming admin closes once any admin exists. The gap (finding
 * L5): if `GENESIS_EMAIL` is left set after bootstrap AND every admin is later
 * removed, `adminCount` falls back to 0 and the genesis mailbox can re-claim
 * admin. This table records that genesis was consumed as a permanent fact that
 * survives admin removal, so re-triggering no longer depends on an operator
 * remembering to unset `GENESIS_EMAIL`.
 *
 * Singleton by construction: a `CHECK (id = 1)` constraint means the table
 * holds at most one row — its mere presence is the "consumed" flag. The row is
 * INSERTed by `GenesisService.claimAdmin` on the first successful claim, never
 * deleted. Mirrors the `platform_settings` singleton pattern.
 *
 * Kept as a dedicated table rather than a column on `platform_settings` so the
 * whole genesis feature stays self-contained and deletable in one commit, the
 * property `GenesisService`'s header calls out.
 */
export class AddGenesisBootstrapMarker1793500000000 implements MigrationInterface {
  name = 'AddGenesisBootstrapMarker1793500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "genesis_bootstrap" (
        "id" integer NOT NULL,
        "consumed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_genesis_bootstrap" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_genesis_bootstrap_singleton" CHECK ("id" = 1)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "genesis_bootstrap"`);
  }
}
