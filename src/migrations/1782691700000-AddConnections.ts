import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConnections1782691700000 implements MigrationInterface {
  name = 'AddConnections1782691700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "connections_status_enum" AS ENUM('pending', 'accepted', 'declined', 'blocked')`,
    );
    await queryRunner.query(`
      CREATE TABLE "connections" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "requester_id" uuid NOT NULL,
        "addressee_id" uuid NOT NULL,
        "user_low" uuid NOT NULL,
        "user_high" uuid NOT NULL,
        "status" "connections_status_enum" NOT NULL DEFAULT 'pending',
        "blocked_by" uuid,
        "request_message" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "responded_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_connections" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_connections_pair" UNIQUE ("user_low", "user_high")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_connections_requester_id" ON "connections" ("requester_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_connections_addressee_id" ON "connections" ("addressee_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "connections" ADD CONSTRAINT "FK_connections_requester_id"
        FOREIGN KEY ("requester_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "connections" ADD CONSTRAINT "FK_connections_addressee_id"
        FOREIGN KEY ("addressee_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "connections" DROP CONSTRAINT "FK_connections_addressee_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "connections" DROP CONSTRAINT "FK_connections_requester_id"`,
    );
    await queryRunner.query(`DROP TABLE "connections"`);
    await queryRunner.query(`DROP TYPE "connections_status_enum"`);
  }
}
