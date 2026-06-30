import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMessaging1782691800000 implements MigrationInterface {
  name = 'AddMessaging1782691800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "is_official" boolean NOT NULL DEFAULT false,
        "pair_key" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_conversations_pair_key" ON "conversations" ("pair_key")`,
    );

    await queryRunner.query(`
      CREATE TABLE "conversation_participants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "last_read_at" TIMESTAMP WITH TIME ZONE,
        "muted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_conversation_participants" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conversation_participants" UNIQUE ("conversation_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_participants_conversation_id" ON "conversation_participants" ("conversation_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_participants_user_id" ON "conversation_participants" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL,
        "sender_id" uuid NOT NULL,
        "body" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "edited_at" TIMESTAMP WITH TIME ZONE,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_messages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_conversation_id" ON "messages" ("conversation_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD CONSTRAINT "FK_conversation_participants_conversation_id"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD CONSTRAINT "FK_conversation_participants_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_conversation_id"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_sender_id"
        FOREIGN KEY ("sender_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_sender_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_conversation_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP CONSTRAINT "FK_conversation_participants_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP CONSTRAINT "FK_conversation_participants_conversation_id"`,
    );
    await queryRunner.query(`DROP TABLE "messages"`);
    await queryRunner.query(`DROP TABLE "conversation_participants"`);
    await queryRunner.query(`DROP TABLE "conversations"`);
  }
}
