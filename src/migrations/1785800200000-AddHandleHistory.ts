import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `handle_history` reservation ledger — one row per RELEASED handle
 * (a username rename or a subprofile unpublish), recording who last held the
 * name and when it becomes freely claimable again.
 *
 * Closes an impersonation hole: mentions are stored as raw `@slug` text and
 * re-resolved to a user at fan-out time, so a handle reclaimed by a stranger
 * the instant it is freed would silently re-point every old `@slug` at the new
 * owner. Until `reclaimable_at` (release + a 30-day cooldown) the name reads as
 * taken to everyone but its previous owner, who may reclaim it. `HandlesService`
 * writes this row on release and clears it on (re)claim.
 *
 * The row mirrors the `handles` owner shape — a CHECK constraint keeps exactly
 * one of `previous_owner_user_id` / `previous_owner_subprofile_id` set to match
 * `previous_owner_kind` — and REUSES the existing `handles_owner_kind_enum`
 * type rather than minting a new one (so `down()` must NOT drop that shared
 * type). Both owner FKs cascade: a deleted user or subprofile drops the
 * reservation, freeing the name it protected.
 */
export class AddHandleHistory1785800200000 implements MigrationInterface {
  name = 'AddHandleHistory1785800200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- table ---------------------------------------------------------------
    // Reuses "handles_owner_kind_enum" (created by AddHandles1782800660000).
    await queryRunner.query(`
      CREATE TABLE "handle_history" (
        "name" character varying NOT NULL,
        "previous_owner_kind" "handles_owner_kind_enum" NOT NULL,
        "previous_owner_user_id" uuid,
        "previous_owner_subprofile_id" uuid,
        "released_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reclaimable_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_handle_history" PRIMARY KEY ("name"),
        CONSTRAINT "CHK_handle_history_owner" CHECK (
          ("previous_owner_kind" = 'profile' AND "previous_owner_user_id" IS NOT NULL AND "previous_owner_subprofile_id" IS NULL)
          OR
          ("previous_owner_kind" = 'subprofile' AND "previous_owner_subprofile_id" IS NOT NULL AND "previous_owner_user_id" IS NULL)
        )
      )
    `);

    // --- indexes -------------------------------------------------------------
    await queryRunner.query(
      `CREATE INDEX "IDX_handle_history_previous_owner_user_id" ON "handle_history" ("previous_owner_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_handle_history_previous_owner_subprofile_id" ON "handle_history" ("previous_owner_subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_handle_history_reclaimable_at" ON "handle_history" ("reclaimable_at")`,
    );

    // --- foreign keys --------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "handle_history" ADD CONSTRAINT "FK_handle_history_previous_owner_user_id"
        FOREIGN KEY ("previous_owner_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "handle_history" ADD CONSTRAINT "FK_handle_history_previous_owner_subprofile_id"
        FOREIGN KEY ("previous_owner_subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "handle_history" DROP CONSTRAINT "FK_handle_history_previous_owner_subprofile_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "handle_history" DROP CONSTRAINT "FK_handle_history_previous_owner_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_handle_history_reclaimable_at"`);
    await queryRunner.query(
      `DROP INDEX "IDX_handle_history_previous_owner_subprofile_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_handle_history_previous_owner_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "handle_history"`);
    // NB: "handles_owner_kind_enum" is shared with `handles` — do NOT drop it.
  }
}
