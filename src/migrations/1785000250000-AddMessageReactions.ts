import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMessageReactions1785000250000 implements MigrationInterface {
  name = 'AddMessageReactions1785000250000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "message_reactions_key_enum" AS ENUM('love', 'laugh', 'like', 'wow', 'sad', 'thanks')`,
    );

    await queryRunner.query(`
      CREATE TABLE "message_reactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "message_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "key" "message_reactions_key_enum" NOT NULL,
        CONSTRAINT "PK_message_reactions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_message_reactions" UNIQUE ("message_id", "user_id", "key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_message_reactions_message_id" ON "message_reactions" ("message_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_reactions_user_id" ON "message_reactions" ("user_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "message_reactions" ADD CONSTRAINT "FK_message_reactions_message_id" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_reactions" ADD CONSTRAINT "FK_message_reactions_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "message_reactions" DROP CONSTRAINT "FK_message_reactions_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_reactions" DROP CONSTRAINT "FK_message_reactions_message_id"`,
    );

    await queryRunner.query(`DROP TABLE "message_reactions"`);

    await queryRunner.query(`DROP TYPE "message_reactions_key_enum"`);
  }
}
