// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-449: a persona delete keeps its handle reserved for the full reclaim
 * cooldown.
 *
 * `SubprofilesService.remove` now releases the persona's registry handle
 * through `HandlesService.release` (no forwarding) before the row is deleted,
 * which writes a `handle_history` reservation. Until now
 * `handle_history.previous_owner_subprofile_id` was `ON DELETE CASCADE`, so
 * the delete would take that reservation (and every older one the persona
 * left behind) with it, and anyone could claim the name at once. The FK now
 * sets the column to NULL, so every reservation survives the delete.
 *
 * A surviving row names no persona, so the owner CHECK is relaxed: a
 * `subprofile` reservation may now carry a NULL `previous_owner_subprofile_id`
 * (a profile reservation is unchanged). A NULL owner matches nobody in
 * `HandlesService`, so the name reads as taken to everyone and never forwards
 * until the cooldown lapses.
 *
 * The `handles` registry FK stays `ON DELETE CASCADE`: the release deletes the
 * registry row before the persona goes, so nothing is left for it to cascade.
 *
 * `down` removes the ownerless persona reservations (the old CHECK cannot
 * hold them), then restores the strict CHECK and the cascading FK.
 */
export class KeepHandleHistoryOnPersonaDelete1824710000000 implements MigrationInterface {
  name = 'KeepHandleHistoryOnPersonaDelete1824710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "handle_history" DROP CONSTRAINT "CHK_handle_history_owner"`,
    );
    await queryRunner.query(`
      ALTER TABLE "handle_history" ADD CONSTRAINT "CHK_handle_history_owner" CHECK (
        ("previous_owner_kind" = 'profile' AND "previous_owner_user_id" IS NOT NULL AND "previous_owner_subprofile_id" IS NULL)
        OR
        ("previous_owner_kind" = 'subprofile' AND "previous_owner_user_id" IS NULL)
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "handle_history" DROP CONSTRAINT "FK_handle_history_previous_owner_subprofile_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "handle_history" ADD CONSTRAINT "FK_handle_history_previous_owner_subprofile_id"
        FOREIGN KEY ("previous_owner_subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "handle_history" DROP CONSTRAINT "FK_handle_history_previous_owner_subprofile_id"`,
    );
    await queryRunner.query(
      `DELETE FROM "handle_history" WHERE "previous_owner_kind" = 'subprofile' AND "previous_owner_subprofile_id" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "handle_history" DROP CONSTRAINT "CHK_handle_history_owner"`,
    );
    await queryRunner.query(`
      ALTER TABLE "handle_history" ADD CONSTRAINT "CHK_handle_history_owner" CHECK (
        ("previous_owner_kind" = 'profile' AND "previous_owner_user_id" IS NOT NULL AND "previous_owner_subprofile_id" IS NULL)
        OR
        ("previous_owner_kind" = 'subprofile' AND "previous_owner_subprofile_id" IS NOT NULL AND "previous_owner_user_id" IS NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "handle_history" ADD CONSTRAINT "FK_handle_history_previous_owner_subprofile_id"
        FOREIGN KEY ("previous_owner_subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }
}
