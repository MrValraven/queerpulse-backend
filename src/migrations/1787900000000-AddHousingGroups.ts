import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the vetted housing-groups feature (P3.1/P3.3): access-gated community
 * groups (`housing_groups`) with screening-question join requests
 * (`group_join_requests`) and norm-enforced listings (`group_listings`).
 *
 * Groups start empty by design — this migration creates no seed rows.
 * Additive and safe: no existing table is touched.
 */
export class AddHousingGroups1787900000000 implements MigrationInterface {
  name = 'AddHousingGroups1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "group_join_requests_status_enum" AS ENUM('pending','approved','declined')`,
    );

    await queryRunner.query(
      `CREATE TABLE "housing_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        "name_em" character varying,
        "city" character varying NOT NULL,
        "blurb" text NOT NULL,
        "is_access_gated" boolean NOT NULL DEFAULT true,
        "norms" jsonb NOT NULL DEFAULT '[]',
        "screening_questions" jsonb NOT NULL DEFAULT '[]',
        "member_count" integer NOT NULL DEFAULT 0,
        "published" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_housing_groups" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_groups_slug" ON "housing_groups" ("slug")`,
    );

    await queryRunner.query(
      `CREATE TABLE "group_join_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "group_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "relationship" text NOT NULL,
        "answers" jsonb NOT NULL DEFAULT '[]',
        "note" text,
        "user_id" uuid,
        "status" "group_join_requests_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_group_join_requests" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_group_join_requests_group_id" ON "group_join_requests" ("group_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_group_join_requests_user_id" ON "group_join_requests" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_join_requests" ADD CONSTRAINT "FK_group_join_requests_group_id" FOREIGN KEY ("group_id") REFERENCES "housing_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_join_requests" ADD CONSTRAINT "FK_group_join_requests_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE TABLE "group_listings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "group_id" uuid NOT NULL,
        "title" character varying NOT NULL,
        "description" text NOT NULL,
        "neighbourhood" character varying NOT NULL,
        "price_euros" integer NOT NULL,
        "accessibility_info" text NOT NULL,
        "hidden" boolean NOT NULL DEFAULT false,
        "hidden_reason" text,
        "posted_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_group_listings" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_group_listings_group_id" ON "group_listings" ("group_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" ADD CONSTRAINT "FK_group_listings_group_id" FOREIGN KEY ("group_id") REFERENCES "housing_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "group_listings" DROP CONSTRAINT "FK_group_listings_group_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_group_listings_group_id"`);
    await queryRunner.query(`DROP TABLE "group_listings"`);

    await queryRunner.query(
      `ALTER TABLE "group_join_requests" DROP CONSTRAINT "FK_group_join_requests_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_join_requests" DROP CONSTRAINT "FK_group_join_requests_group_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_group_join_requests_user_id"`);
    await queryRunner.query(`DROP INDEX "IDX_group_join_requests_group_id"`);
    await queryRunner.query(`DROP TABLE "group_join_requests"`);

    await queryRunner.query(`DROP INDEX "UQ_housing_groups_slug"`);
    await queryRunner.query(`DROP TABLE "housing_groups"`);

    await queryRunner.query(`DROP TYPE "group_join_requests_status_enum"`);
  }
}
