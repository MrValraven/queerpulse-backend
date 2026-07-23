import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrgTiers1785000210000 implements MigrationInterface {
  name = 'AddOrgTiers1785000210000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "org_tiers_cta_type_enum" AS ENUM('toast', 'link', 'propose')`,
    );
    await queryRunner.query(`
      CREATE TABLE "org_tiers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        "price_display" character varying NOT NULL,
        "price_period" character varying NOT NULL,
        "dek" text NOT NULL,
        "bullets" text array NOT NULL DEFAULT '{}',
        "footnote" text NOT NULL,
        "cta_type" "org_tiers_cta_type_enum" NOT NULL,
        "cta_label" character varying NOT NULL,
        "cta_target" character varying,
        "featured" boolean NOT NULL DEFAULT false,
        "sort_order" integer NOT NULL DEFAULT 0,
        "published" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_org_tiers_slug" UNIQUE ("slug"),
        CONSTRAINT "PK_org_tiers_id" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "org_tiers"`);
    await queryRunner.query(`DROP TYPE "org_tiers_cta_type_enum"`);
  }
}
