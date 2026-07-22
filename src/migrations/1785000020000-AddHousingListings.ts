// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHousingListings1785000020000 implements MigrationInterface {
  name = 'AddHousingListings1785000020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "housing_listings_status_enum" AS ENUM('review', 'question', 'live')`,
    );
    await queryRunner.query(
      `CREATE TYPE "housing_listings_type_enum" AS ENUM('sublet', 'room', 'short', 'studio')`,
    );

    // Backs `HousingListing.ref` (`QPH-<year>-<seq>`) — atomic/monotonic, no
    // retry loop needed (mirrors `listings_ref_seq`).
    await queryRunner.query(
      `CREATE SEQUENCE "housing_listings_ref_seq" START 1`,
    );

    await queryRunner.query(`
      CREATE TABLE "housing_listings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ref" character varying NOT NULL,
        "slug" character varying NOT NULL,
        "owner_id" uuid NOT NULL,
        "status" "housing_listings_status_enum" NOT NULL DEFAULT 'review',
        "type" "housing_listings_type_enum" NOT NULL,
        "title" character varying(200) NOT NULL,
        "blurb" character varying(200) NOT NULL DEFAULT '',
        "city" character varying(120) NOT NULL,
        "area" character varying(120) NOT NULL DEFAULT '',
        "rent_euros" integer NOT NULL,
        "bills_included" boolean NOT NULL DEFAULT false,
        "lgbtq_friendly" boolean NOT NULL DEFAULT false,
        "available_from" date,
        "min_stay_months" integer,
        "description" text NOT NULL DEFAULT '',
        "features" text array NOT NULL DEFAULT '{}',
        "ideal_for" text array NOT NULL DEFAULT '{}',
        "gallery" text array NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_housing_listings" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_listings_ref" ON "housing_listings" ("ref")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_listings_slug" ON "housing_listings" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_owner_id" ON "housing_listings" ("owner_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_status" ON "housing_listings" ("status")`,
    );

    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD CONSTRAINT "FK_housing_listings_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP CONSTRAINT "FK_housing_listings_owner_id"`,
    );
    await queryRunner.query(`DROP TABLE "housing_listings"`);
    await queryRunner.query(`DROP SEQUENCE "housing_listings_ref_seq"`);
    await queryRunner.query(`DROP TYPE "housing_listings_type_enum"`);
    await queryRunner.query(`DROP TYPE "housing_listings_status_enum"`);
  }
}
