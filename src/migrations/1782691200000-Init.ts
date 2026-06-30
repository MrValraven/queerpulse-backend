import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1782691200000 implements MigrationInterface {
  name = 'Init1782691200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // UUID PK defaults need uuid_generate_v4() from the uuid-ossp extension.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(
      `CREATE TYPE "users_status_enum" AS ENUM('pending', 'active', 'suspended')`,
    );
    await queryRunner.query(
      `CREATE TYPE "users_role_enum" AS ENUM('member', 'moderator', 'admin')`,
    );
    await queryRunner.query(
      `CREATE TYPE "profiles_visibility_enum" AS ENUM('open', 'network', 'private')`,
    );

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "google_id" character varying NOT NULL,
        "email" character varying NOT NULL,
        "status" "users_status_enum" NOT NULL DEFAULT 'pending',
        "role" "users_role_enum" NOT NULL DEFAULT 'member',
        "invited_by" uuid,
        "activated_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_google_id" UNIQUE ("google_id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "profiles" (
        "user_id" uuid NOT NULL,
        "slug" character varying NOT NULL,
        "first_name" character varying NOT NULL,
        "last_name" character varying NOT NULL,
        "pronouns" character varying,
        "tagline" character varying,
        "bio" text,
        "location" character varying,
        "avatar_url" character varying,
        "visibility" "profiles_visibility_enum" NOT NULL DEFAULT 'open',
        "open_to" text array NOT NULL DEFAULT '{}',
        "tags" text array NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_profiles_slug" UNIQUE ("slug"),
        CONSTRAINT "PK_profiles" PRIMARY KEY ("user_id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ADD CONSTRAINT "FK_users_invited_by"
        FOREIGN KEY ("invited_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "profiles" ADD CONSTRAINT "FK_profiles_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" DROP CONSTRAINT "FK_profiles_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_users_invited_by"`,
    );
    await queryRunner.query(`DROP TABLE "profiles"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "profiles_visibility_enum"`);
    await queryRunner.query(`DROP TYPE "users_role_enum"`);
    await queryRunner.query(`DROP TYPE "users_status_enum"`);
  }
}
