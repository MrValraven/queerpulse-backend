import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventReminderSentAt1782692100000 implements MigrationInterface {
  name = 'AddEventReminderSentAt1782692100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" ADD "reminder_sent_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN "reminder_sent_at"`,
    );
  }
}
