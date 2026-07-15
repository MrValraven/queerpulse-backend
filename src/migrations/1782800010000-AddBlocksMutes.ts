import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `blocks` (hard, mutual severance) + `mutes` (one-way, soft silence) — the
 * two always-on safety primitives backing `src/social` (spec §2/§3 Tier 1
 * "social"). Mirrors `AddConnections1782691700000`'s table/index/FK shape.
 *
 * NOT run as part of this task — the orchestrator sequences + runs it
 * against `_test`/dev DBs after wiring `SocialModule` into `app.module.ts`.
 */
export class AddBlocksMutes1782800010000 implements MigrationInterface {
  name = 'AddBlocksMutes1782800010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "blocks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "blocker_id" uuid NOT NULL,
        "blocked_id" uuid NOT NULL,
        "reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_blocks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_blocks_pair" UNIQUE ("blocker_id", "blocked_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_blocks_blocker_id" ON "blocks" ("blocker_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_blocks_blocked_id" ON "blocks" ("blocked_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "blocks" ADD CONSTRAINT "FK_blocks_blocker_id"
        FOREIGN KEY ("blocker_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "blocks" ADD CONSTRAINT "FK_blocks_blocked_id"
        FOREIGN KEY ("blocked_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "mutes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "muter_id" uuid NOT NULL,
        "muted_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mutes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mutes_pair" UNIQUE ("muter_id", "muted_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_mutes_muter_id" ON "mutes" ("muter_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mutes_muted_id" ON "mutes" ("muted_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "mutes" ADD CONSTRAINT "FK_mutes_muter_id"
        FOREIGN KEY ("muter_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "mutes" ADD CONSTRAINT "FK_mutes_muted_id"
        FOREIGN KEY ("muted_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mutes" DROP CONSTRAINT "FK_mutes_muted_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mutes" DROP CONSTRAINT "FK_mutes_muter_id"`,
    );
    await queryRunner.query(`DROP TABLE "mutes"`);

    await queryRunner.query(
      `ALTER TABLE "blocks" DROP CONSTRAINT "FK_blocks_blocked_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "blocks" DROP CONSTRAINT "FK_blocks_blocker_id"`,
    );
    await queryRunner.query(`DROP TABLE "blocks"`);
  }
}
