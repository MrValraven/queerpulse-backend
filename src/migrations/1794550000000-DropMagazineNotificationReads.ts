import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops `magazine_notification_reads`, the read-cursor table behind the
 * magazine desk's "Since Friday" panel.
 *
 * The panel was removed from the editor entirely — the rail bell, the panel
 * itself, and both `/magazine/admin/notifications` endpoints are gone — so
 * nothing reads or writes this table any more. `magazine_piece_event`, the
 * audit trail the panel was a view over, is untouched: the piece History tab
 * and the desk sidebar's activity feed still read it.
 *
 * The rows here are per-viewer dismissal timestamps, not editorial content:
 * dropping them loses nothing that can't be reconstructed by the surfaces
 * that remain. `down()` recreates the empty table (same columns, PK and
 * cascade FK as `AddMagazineNotificationReads1791300000000`); the cursors
 * themselves are not recoverable.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class DropMagazineNotificationReads1794550000000 implements MigrationInterface {
  name = 'DropMagazineNotificationReads1794550000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "magazine_notification_reads"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_notification_reads" (
        "actor_id" uuid NOT NULL,
        "last_read_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_magazine_notification_reads" PRIMARY KEY ("actor_id")
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "magazine_notification_reads"
        ADD CONSTRAINT "FK_magazine_notification_reads_actor_id"
        FOREIGN KEY ("actor_id") REFERENCES "users"("id")
        ON DELETE CASCADE
    `);
  }
}
