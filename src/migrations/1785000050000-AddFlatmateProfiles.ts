// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFlatmateProfiles1785000050000 implements MigrationInterface {
  name = 'AddFlatmateProfiles1785000050000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "flatmate_profiles_type_enum" AS ENUM('seeking', 'offering')`,
    );

    await queryRunner.query(`
      CREATE TABLE "flatmate_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_id" uuid NOT NULL,
        "slug" character varying NOT NULL,
        "type" "flatmate_profiles_type_enum" NOT NULL,
        "pronouns" character varying(60) NOT NULL DEFAULT '',
        "neighbourhood" character varying(120) NOT NULL DEFAULT '',
        "budget_euros" integer NOT NULL,
        "move_in_from" date,
        "flexible_timing" boolean NOT NULL DEFAULT false,
        "about" text NOT NULL DEFAULT '',
        "lifestyle_tags" text array NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_flatmate_profiles" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_flatmate_profiles_owner_id" ON "flatmate_profiles" ("owner_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_flatmate_profiles_slug" ON "flatmate_profiles" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_flatmate_profiles_type" ON "flatmate_profiles" ("type")`,
    );

    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" ADD CONSTRAINT "FK_flatmate_profiles_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" DROP CONSTRAINT "FK_flatmate_profiles_owner_id"`,
    );
    await queryRunner.query(`DROP TABLE "flatmate_profiles"`);
    await queryRunner.query(`DROP TYPE "flatmate_profiles_type_enum"`);
  }
}
