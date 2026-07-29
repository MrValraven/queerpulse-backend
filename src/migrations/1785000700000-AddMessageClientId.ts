import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMessageClientId1785000700000 implements MigrationInterface {
  name = 'AddMessageClientId1785000700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "client_message_id" uuid`,
    );
    // Idempotency key: a conversation holds at most one message per client id,
    // so the dual HTTP + WS write paths (and any retry from the offline outbox)
    // collapse to a single row instead of duplicating. Partial so NULL client
    // ids — legacy rows and server-originated messages (message-request seeds,
    // cross-domain enquiries) — are exempt from the uniqueness constraint.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_messages_conversation_client_id" ON "messages" ("conversation_id", "client_message_id") WHERE "client_message_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "UQ_messages_conversation_client_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "client_message_id"`,
    );
  }
}
