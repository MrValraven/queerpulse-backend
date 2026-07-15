import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSavedItems1782800110000 implements MigrationInterface {
  name = 'AddSavedItems1782800110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "saved_item_subject_type_enum" AS ENUM('article', 'film', 'job', 'post', 'event', 'group')`,
    );

    // Polymorphic bookmark: (subject_type, subject_id) identify the saved
    // thing without an FK, since targets span several unrelated domains
    // (magazine articles, cinema films, jobs, community posts, events,
    // groups/communities). title/href/meta/description/read_time are the
    // presentational snapshot the frontend sends on save and expects back
    // unchanged — not re-derived from the underlying resource, so a bookmark
    // survives the resource being edited or removed.
    await queryRunner.query(`
      CREATE TABLE "saved_item" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "subject_type" "saved_item_subject_type_enum" NOT NULL,
        "subject_id" character varying NOT NULL,
        "title" character varying NOT NULL,
        "href" character varying,
        "meta" character varying,
        "description" text,
        "read_time" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_saved_item" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_saved_item_subject" UNIQUE ("user_id", "subject_type", "subject_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_saved_item_user_id" ON "saved_item" ("user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "saved_item" ADD CONSTRAINT "FK_saved_item_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "saved_item" DROP CONSTRAINT "FK_saved_item_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_saved_item_user_id"`);
    await queryRunner.query(`DROP TABLE "saved_item"`);
    await queryRunner.query(`DROP TYPE "saved_item_subject_type_enum"`);
  }
}
