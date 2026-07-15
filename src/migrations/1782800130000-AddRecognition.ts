import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `recognition_stats` (lifetime XP total per user) + `recognition_awards`
 * (individual badges a member has earned) + `recognition_perk_claims`
 * (one-time perks a member has permanently claimed) — backing `src/recognition`
 * (spec §3 Tier 2 "recognition"). Level names, the level ladder, and the
 * badge/perk catalogues themselves are static content living in
 * `src/recognition/recognition.catalog.ts`, not the database — only per-user
 * state is persisted here. Mirrors `AddConsent1782800040000`'s/
 * `AddBlocksMutes1782800010000`'s table/index/FK shape.
 *
 * NOT run as part of this task — the orchestrator sequences + runs it against
 * `_test`/dev DBs after wiring `RecognitionModule` into `app.module.ts`.
 */
export class AddRecognition1782800130000 implements MigrationInterface {
  name = 'AddRecognition1782800130000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recognition_stats" (
        "user_id" uuid NOT NULL,
        "xp" integer NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recognition_stats" PRIMARY KEY ("user_id")
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "recognition_stats" ADD CONSTRAINT "FK_recognition_stats_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "recognition_awards" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "badge_key" character varying NOT NULL,
        "context" text,
        "awarded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recognition_awards" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_recognition_awards_user_badge" UNIQUE ("user_id", "badge_key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_recognition_awards_user_id" ON "recognition_awards" ("user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "recognition_awards" ADD CONSTRAINT "FK_recognition_awards_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "recognition_perk_claims" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "perk_key" character varying NOT NULL,
        "claimed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recognition_perk_claims" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_recognition_perk_claims_user_perk" UNIQUE ("user_id", "perk_key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_recognition_perk_claims_user_id" ON "recognition_perk_claims" ("user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "recognition_perk_claims" ADD CONSTRAINT "FK_recognition_perk_claims_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recognition_perk_claims" DROP CONSTRAINT "FK_recognition_perk_claims_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "recognition_perk_claims"`);

    await queryRunner.query(
      `ALTER TABLE "recognition_awards" DROP CONSTRAINT "FK_recognition_awards_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "recognition_awards"`);

    await queryRunner.query(
      `ALTER TABLE "recognition_stats" DROP CONSTRAINT "FK_recognition_stats_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "recognition_stats"`);
  }
}
