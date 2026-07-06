import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanies1782693300000 implements MigrationInterface {
  name = 'AddCompanies1782693300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "companies" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name_text" character varying NOT NULL,
        "tagline" character varying NOT NULL,
        "about" text NOT NULL,
        "queer_run" boolean NOT NULL DEFAULT false,
        "queer_led" boolean NOT NULL DEFAULT false,
        "verified" boolean NOT NULL DEFAULT false,
        "values" jsonb NOT NULL DEFAULT '[]',
        "info" jsonb NOT NULL DEFAULT '[]',
        "team_count" integer NOT NULL DEFAULT 0,
        "hiring_contact" jsonb,
        "work" jsonb NOT NULL DEFAULT '[]',
        "owner_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_companies" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_companies_slug" ON "companies" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_companies_owner_id" ON "companies" ("owner_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "company_team_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_company_team_members" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_company_team_members" UNIQUE ("company_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_company_team_members_company_id" ON "company_team_members" ("company_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_company_team_members_user_id" ON "company_team_members" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "company_reviews" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "title" character varying NOT NULL,
        "stars" integer NOT NULL,
        "byline" character varying NOT NULL,
        "body" jsonb NOT NULL DEFAULT '[]',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_company_reviews" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_company_reviews" UNIQUE ("company_id", "author_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_company_reviews_company_id" ON "company_reviews" ("company_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_company_reviews_author_id" ON "company_reviews" ("author_id")`,
    );

    // Foreign keys
    await queryRunner.query(
      `ALTER TABLE "companies" ADD CONSTRAINT "FK_companies_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_team_members" ADD CONSTRAINT "FK_company_team_members_company_id" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_team_members" ADD CONSTRAINT "FK_company_team_members_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_reviews" ADD CONSTRAINT "FK_company_reviews_company_id" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_reviews" ADD CONSTRAINT "FK_company_reviews_author_id" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "company_reviews" DROP CONSTRAINT "FK_company_reviews_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_reviews" DROP CONSTRAINT "FK_company_reviews_company_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_team_members" DROP CONSTRAINT "FK_company_team_members_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_team_members" DROP CONSTRAINT "FK_company_team_members_company_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" DROP CONSTRAINT "FK_companies_owner_id"`,
    );

    await queryRunner.query(`DROP TABLE "company_reviews"`);
    await queryRunner.query(`DROP TABLE "company_team_members"`);
    await queryRunner.query(`DROP TABLE "companies"`);
  }
}
