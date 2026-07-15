import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConsent1782800040000 implements MigrationInterface {
  name = 'AddConsent1782800040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "consent_record_source_enum" AS ENUM('banner', 'preference_center', 'settings_pane')`,
    );
    await queryRunner.query(
      `CREATE TYPE "consent_record_action_enum" AS ENUM('granted', 'updated', 'withdrawn')`,
    );

    // Append-only consent log: no unique constraint — every POST inserts a
    // new versioned row so the exact decision at each policy version is kept.
    await queryRunner.query(`
      CREATE TABLE "consent_record" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "anon_id" character varying,
        "analytics" boolean NOT NULL,
        "monitoring" boolean NOT NULL,
        "policy_version" character varying NOT NULL,
        "source" "consent_record_source_enum" NOT NULL,
        "action" "consent_record_action_enum" NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_consent_record" PRIMARY KEY ("id")
      )
    `);
    // Composite index supports the hot path: fetch a user's latest record
    // (WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1).
    await queryRunner.query(
      `CREATE INDEX "IDX_consent_record_user_id" ON "consent_record" ("user_id", "created_at")`,
    );
    await queryRunner.query(`
      ALTER TABLE "consent_record" ADD CONSTRAINT "FK_consent_record_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "consent_record" DROP CONSTRAINT "FK_consent_record_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "consent_record"`);
    await queryRunner.query(`DROP TYPE "consent_record_action_enum"`);
    await queryRunner.query(`DROP TYPE "consent_record_source_enum"`);
  }
}
