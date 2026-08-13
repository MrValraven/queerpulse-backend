import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the tiered identity-verification model: one `member_verifications` row
 * per user holding their current level (`none|email|phone|id_verified`) and the
 * provenance of how it was reached — never any document/biometric data (GDPR
 * Art.9 stays entirely behind the external provider seam).
 *
 * Additive and safe: existing members are seeded at the `email` floor
 * (Google-only sign-in already proves email control), verified-at stamped to
 * their `created_at`. Nothing is blocked by this migration — the step-up gates
 * live in application code, not the schema.
 */
export class AddMemberVerification1787800000000 implements MigrationInterface {
  name = 'AddMemberVerification1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "member_verification_level_enum" AS ENUM('none', 'email', 'phone', 'id_verified')`,
    );

    await queryRunner.query(`
      CREATE TABLE "member_verifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "level" "member_verification_level_enum" NOT NULL DEFAULT 'email',
        "method" character varying(64),
        "provider" character varying(64),
        "provider_ref" character varying(255),
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_member_verifications" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_member_verifications_user_id" ON "member_verifications" ("user_id")`,
    );
    // The identity callback resolves a member by their opaque provider ref.
    await queryRunner.query(
      `CREATE INDEX "IDX_member_verifications_provider_ref" ON "member_verifications" ("provider_ref")`,
    );

    await queryRunner.query(
      `ALTER TABLE "member_verifications" ADD CONSTRAINT "FK_member_verifications_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // Seed existing members at the email floor — a real, earned level (Google
    // sign-in federates a verified email), stamped to when the account began.
    await queryRunner.query(`
      INSERT INTO "member_verifications" ("user_id", "level", "method", "provider", "verified_at")
      SELECT "id", 'email', 'google_oauth', NULL, "created_at" FROM "users"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_verifications" DROP CONSTRAINT "FK_member_verifications_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "member_verifications"`);
    await queryRunner.query(`DROP TYPE "member_verification_level_enum"`);
  }
}
