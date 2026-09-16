import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-258: `chat_gateway_instance_heartbeats`, the runtime signal
 * `ChatSingleInstanceGuard` reads to detect a Railway scale-out that no
 * environment variable can name (see that guard's doc, and
 * `chat-replica-signals.ts`'s, for why the env-var route is a dead end on
 * Railway specifically).
 *
 * One row per LIVE process, upserted by that same guard on a short interval
 * and keyed on its own `instanceId` (`RAILWAY_REPLICA_ID` where present,
 * otherwise a generated id). Two or more DISTINCT ids with a recent
 * `last_seen_at` means two or more processes are alive right now, which the
 * guard then treats exactly like a declared multi-replica config.
 *
 * NO INDEX BEYOND THE PRIMARY KEY, deliberately: this table holds at most a
 * small handful of rows (one per replica this app will ever actually run),
 * so every read the guard does is already a full scan of a table too small
 * for an index to matter, mirroring `1817220000000-AddFeatureUsageDaily`'s
 * identical reasoning for the same shape of table.
 */
export class AddChatGatewayInstanceHeartbeats1820700000000 implements MigrationInterface {
  name = 'AddChatGatewayInstanceHeartbeats1820700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chat_gateway_instance_heartbeats" (
        "instance_id" character varying(128) NOT NULL,
        "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_chat_gateway_instance_heartbeats" PRIMARY KEY ("instance_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "chat_gateway_instance_heartbeats"`);
  }
}
