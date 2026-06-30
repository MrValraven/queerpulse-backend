import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMembership1782691400000 implements MigrationInterface {
  name = 'AddMembership1782691400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "invites_status_enum" AS ENUM('pending', 'accepted', 'revoked', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TYPE "join_requests_status_enum" AS ENUM('pending', 'approved', 'declined')`,
    );

    await queryRunner.query(`
      CREATE TABLE "invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "inviter_id" uuid NOT NULL,
        "code" character varying NOT NULL,
        "email" character varying,
        "status" "invites_status_enum" NOT NULL DEFAULT 'pending',
        "accepted_by" uuid,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invites" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_invites_code" ON "invites" ("code")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invites_inviter_id" ON "invites" ("inviter_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "join_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "message" text NOT NULL,
        "status" "join_requests_status_enum" NOT NULL DEFAULT 'pending',
        "reviewed_by" uuid,
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_join_requests" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_join_requests_user_id" ON "join_requests" ("user_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "invites" ADD CONSTRAINT "FK_invites_inviter_id"
        FOREIGN KEY ("inviter_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "invites" ADD CONSTRAINT "FK_invites_accepted_by"
        FOREIGN KEY ("accepted_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "join_requests" ADD CONSTRAINT "FK_join_requests_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "join_requests" ADD CONSTRAINT "FK_join_requests_reviewed_by"
        FOREIGN KEY ("reviewed_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP CONSTRAINT "FK_join_requests_reviewed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP CONSTRAINT "FK_join_requests_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invites" DROP CONSTRAINT "FK_invites_accepted_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invites" DROP CONSTRAINT "FK_invites_inviter_id"`,
    );
    await queryRunner.query(`DROP TABLE "join_requests"`);
    await queryRunner.query(`DROP TABLE "invites"`);
    await queryRunner.query(`DROP TYPE "join_requests_status_enum"`);
    await queryRunner.query(`DROP TYPE "invites_status_enum"`);
  }
}
