import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Two small companions to `identities`. `identity_staff_preferences` carries a
 * row only when a staff member has changed the naming default, so absence
 * means naming is allowed. `identity_blocks` sits beside the existing
 * user-to-user `blocks` table so blocking a business and blocking its owner
 * stay separate acts.
 */
export class AddIdentityStaffPreferencesAndBlocks1821210000000 implements MigrationInterface {
  name = 'AddIdentityStaffPreferencesAndBlocks1821210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "identity_staff_preferences" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "identity_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "should_allow_naming" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_identity_staff_preferences" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_identity_staff_preferences" UNIQUE ("identity_id", "user_id"),
        CONSTRAINT "FK_identity_staff_preferences_identity" FOREIGN KEY ("identity_id")
          REFERENCES "identities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_identity_staff_preferences_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "identity_blocks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "blocker_user_id" uuid NOT NULL,
        "identity_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_identity_blocks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_identity_blocks_pair" UNIQUE ("blocker_user_id", "identity_id"),
        CONSTRAINT "FK_identity_blocks_blocker" FOREIGN KEY ("blocker_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_identity_blocks_identity" FOREIGN KEY ("identity_id")
          REFERENCES "identities"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_identity_blocks_blocker_user_id" ON "identity_blocks" ("blocker_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_identity_blocks_identity_id" ON "identity_blocks" ("identity_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "identity_blocks"`);
    await queryRunner.query(`DROP TABLE "identity_staff_preferences"`);
  }
}
