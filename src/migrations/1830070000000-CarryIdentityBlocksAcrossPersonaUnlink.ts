// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-447: a member's block of a persona survives the persona going
 * unlinked.
 *
 * Unlinking deletes the persona's messaging identity, and its
 * `identity_blocks` rows used to cascade with it, so a member who blocked
 * the named persona's mailbox could be messaged again by the pseudonymous
 * one. The unlink now turns each of those rows into a carried block first
 * (`SubprofilesService.cutTiesToNamedPersona`): the row stops naming an
 * identity and names the persona instead, so it refuses whichever identity
 * the persona speaks through next, in both directions, exactly as the
 * identity block did.
 *
 * A carried row keeps:
 * - `blocked_subprofile_id`: the persona. Its foreign key cascades on
 *   update, so the row follows the persona to the fresh id the unlink gives
 *   it (`issueFreshPersonaId`), and on delete, so deleting the persona
 *   clears it.
 * - `retired_identity_id`: the identity the member blocked, now deleted.
 *   It is the id their Blocked list shows and unblock takes, which they
 *   already knew; the persona's next identity id never reaches them.
 * - `blocked_name_snapshot`: the named persona's name at the unlink, which
 *   the Blocked list shows. The pseudonym's name, handle and avatar never
 *   appear there.
 *
 * `identity_id` becomes nullable, and a CHECK keeps every row exactly one
 * kind: a direct block (identity set, carried columns null) or a carried
 * block (identity null, all three carried columns set).
 *
 * `down` deletes the carried rows (the old shape cannot hold them), then
 * restores the column as it was.
 */
export class CarryIdentityBlocksAcrossPersonaUnlink1830070000000 implements MigrationInterface {
  name = 'CarryIdentityBlocksAcrossPersonaUnlink1830070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_blocks"
        ALTER COLUMN "identity_id" DROP NOT NULL,
        ADD COLUMN "blocked_subprofile_id" uuid,
        ADD COLUMN "retired_identity_id" uuid,
        ADD COLUMN "blocked_name_snapshot" character varying
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_blocks" ADD CONSTRAINT "FK_identity_blocks_blocked_subprofile"
        FOREIGN KEY ("blocked_subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_blocks" ADD CONSTRAINT "CHK_identity_blocks_target" CHECK (
        ("identity_id" IS NOT NULL
          AND "blocked_subprofile_id" IS NULL
          AND "retired_identity_id" IS NULL
          AND "blocked_name_snapshot" IS NULL)
        OR
        ("identity_id" IS NULL
          AND "blocked_subprofile_id" IS NOT NULL
          AND "retired_identity_id" IS NOT NULL
          AND "blocked_name_snapshot" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_identity_blocks_blocked_subprofile_id"
        ON "identity_blocks" ("blocked_subprofile_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_identity_blocks_carried_pair"
        ON "identity_blocks" ("blocker_user_id", "retired_identity_id")
        WHERE "retired_identity_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "identity_blocks" WHERE "identity_id" IS NULL`,
    );
    await queryRunner.query(`DROP INDEX "UQ_identity_blocks_carried_pair"`);
    await queryRunner.query(
      `DROP INDEX "IDX_identity_blocks_blocked_subprofile_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_blocks" DROP CONSTRAINT "CHK_identity_blocks_target"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_blocks" DROP CONSTRAINT "FK_identity_blocks_blocked_subprofile"`,
    );
    await queryRunner.query(`
      ALTER TABLE "identity_blocks"
        DROP COLUMN "blocked_name_snapshot",
        DROP COLUMN "retired_identity_id",
        DROP COLUMN "blocked_subprofile_id",
        ALTER COLUMN "identity_id" SET NOT NULL
    `);
  }
}
