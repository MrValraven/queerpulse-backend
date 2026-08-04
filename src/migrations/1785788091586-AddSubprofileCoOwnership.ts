import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSubprofileCoOwnership1785788091586 implements MigrationInterface {
  name = 'AddSubprofileCoOwnership1785788091586';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subprofile_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "joined_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_members" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subprofile_members" UNIQUE ("subprofile_id", "user_id"),
        CONSTRAINT "FK_subprofile_members_subprofile" FOREIGN KEY ("subprofile_id")
          REFERENCES "subprofiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subprofile_members_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_members_subprofile_id" ON "subprofile_members" ("subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_members_user_id" ON "subprofile_members" ("user_id")`,
    );

    await queryRunner.query(
      `CREATE TYPE "subprofile_invites_status_enum" AS ENUM ('pending','accepted','declined','revoked')`,
    );
    await queryRunner.query(`
      CREATE TABLE "subprofile_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "invited_user_id" uuid NOT NULL,
        "invited_by_user_id" uuid NOT NULL,
        "status" "subprofile_invites_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "responded_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_subprofile_invites" PRIMARY KEY ("id"),
        CONSTRAINT "FK_subprofile_invites_subprofile" FOREIGN KEY ("subprofile_id")
          REFERENCES "subprofiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subprofile_invites_invited_user" FOREIGN KEY ("invited_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subprofile_invites_invited_by" FOREIGN KEY ("invited_by_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_invites_subprofile_id" ON "subprofile_invites" ("subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_invites_invited_user_id" ON "subprofile_invites" ("invited_user_id")`,
    );
    // One PENDING invite per (subprofile, invitee); accepted/declined/revoked
    // rows are exempt so a re-invite after a decline is possible.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_subprofile_invites_pending"
        ON "subprofile_invites" ("subprofile_id", "invited_user_id")
        WHERE "status" = 'pending'
    `);

    // Backfill: every existing subprofile's creator becomes its first member.
    await queryRunner.query(`
      INSERT INTO "subprofile_members" ("subprofile_id", "user_id")
      SELECT "id", "user_id" FROM "subprofiles"
      ON CONFLICT ("subprofile_id", "user_id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "subprofile_invites"`);
    await queryRunner.query(`DROP TYPE "subprofile_invites_status_enum"`);
    await queryRunner.query(`DROP TABLE "subprofile_members"`);
  }
}
