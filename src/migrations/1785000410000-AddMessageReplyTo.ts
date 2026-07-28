import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMessageReplyTo1785000410000 implements MigrationInterface {
  name = 'AddMessageReplyTo1785000410000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" ADD "reply_to_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_reply_to_id" ON "messages" ("reply_to_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_reply_to_id" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_reply_to_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_messages_reply_to_id"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "reply_to_id"`);
  }
}
