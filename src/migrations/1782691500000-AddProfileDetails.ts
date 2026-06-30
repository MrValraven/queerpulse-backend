import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfileDetails1782691500000 implements MigrationInterface {
  name = 'AddProfileDetails1782691500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "social_links" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "platform" character varying NOT NULL,
        "url_or_handle" character varying NOT NULL,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_social_links" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_social_links_user_id" ON "social_links" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "work_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "category" character varying NOT NULL,
        "title" character varying NOT NULL,
        "year" character varying NOT NULL,
        "image_url" character varying,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_work_items" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_work_items_user_id" ON "work_items" ("user_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "social_links" ADD CONSTRAINT "FK_social_links_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "work_items" ADD CONSTRAINT "FK_work_items_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "work_items" DROP CONSTRAINT "FK_work_items_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "social_links" DROP CONSTRAINT "FK_social_links_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "work_items"`);
    await queryRunner.query(`DROP TABLE "social_links"`);
  }
}
