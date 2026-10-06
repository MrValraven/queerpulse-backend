// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lineup invites (2026-10-06). A lineup row becomes an invitation the member
 * answers: `status` is pending until they accept or decline, `invited_by_id`
 * records which organizer sent it (nulled when that account is erased), and
 * `responded_at` stamps the answer.
 *
 * Every existing row was written by a host under the old replace-all editor,
 * so it is backfilled as `accepted` through the column default, which then
 * moves to `pending` for every new invite.
 */
export class AddLineupEntryStatus1830100000000 implements MigrationInterface {
  name = 'AddLineupEntryStatus1830100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "event_lineup_entries_status_enum" AS ENUM ('pending', 'accepted', 'declined')`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" ADD "status" "event_lineup_entries_status_enum" NOT NULL DEFAULT 'accepted'`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" ADD "invited_by_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" ADD "responded_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_lineup_entries_invited_by_id" ON "event_lineup_entries" ("invited_by_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" ADD CONSTRAINT "FK_event_lineup_entries_invited_by_id" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" DROP CONSTRAINT "FK_event_lineup_entries_invited_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_event_lineup_entries_invited_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" DROP COLUMN "responded_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" DROP COLUMN "invited_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" DROP COLUMN "status"`,
    );
    await queryRunner.query(`DROP TYPE "event_lineup_entries_status_enum"`);
  }
}
