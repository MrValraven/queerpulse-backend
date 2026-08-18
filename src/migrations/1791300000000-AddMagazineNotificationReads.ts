import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per staff member's read cursor on the magazine desk's "Since
 * Friday" notifications panel (`MagazineNotificationRead`). `actor_id` is
 * the PK — a viewer accumulates at most one row, upserted on every
 * mark-all-read. FK is ON DELETE CASCADE: a deleted user's read cursor is
 * meaningless.
 */
export class AddMagazineNotificationReads1791300000000 implements MigrationInterface {
  name = 'AddMagazineNotificationReads1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE "magazine_notification_reads"
    `);
  }
}
