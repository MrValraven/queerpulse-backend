import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCinema1782692600000 implements MigrationInterface {
  name = 'AddCinema1782692600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- enum types ---
    await queryRunner.query(
      `CREATE TYPE "cinema_titles_kind_enum" AS ENUM ('film', 'short')`,
    );
    await queryRunner.query(
      `CREATE TYPE "cinema_titles_status_enum" AS ENUM ('draft', 'awaiting_upload', 'processing', 'ready', 'failed')`,
    );

    // --- cinema_titles ---
    await queryRunner.query(`
      CREATE TABLE "cinema_titles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" "cinema_titles_kind_enum" NOT NULL,
        "title" character varying NOT NULL,
        "description" text,
        "cover_image_url" character varying,
        "status" "cinema_titles_status_enum" NOT NULL DEFAULT 'draft',
        "error_message" text,
        "mux_upload_id" character varying,
        "mux_asset_id" character varying,
        "mux_playback_id" character varying,
        "pending_mux_upload_id" character varying,
        "pending_mux_asset_id" character varying,
        "duration_seconds" integer,
        "aspect_ratio" character varying,
        "published_at" timestamptz,
        "view_count" integer NOT NULL DEFAULT 0,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cinema_titles" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "cinema_titles" ADD CONSTRAINT "FK_cinema_titles_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cinema_titles_status" ON "cinema_titles" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cinema_titles_published_at" ON "cinema_titles" ("published_at")`,
    );
    // Webhook/reconciliation lookups match on provider ids; partial unique
    // indexes keep those lookups fast and forbid two titles claiming one id.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cinema_titles_mux_upload_id" ON "cinema_titles" ("mux_upload_id") WHERE "mux_upload_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cinema_titles_mux_asset_id" ON "cinema_titles" ("mux_asset_id") WHERE "mux_asset_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cinema_titles_pending_mux_upload_id" ON "cinema_titles" ("pending_mux_upload_id") WHERE "pending_mux_upload_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cinema_titles_pending_mux_asset_id" ON "cinema_titles" ("pending_mux_asset_id") WHERE "pending_mux_asset_id" IS NOT NULL`,
    );

    // --- cinema_watch_progress ---
    await queryRunner.query(`
      CREATE TABLE "cinema_watch_progress" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "title_id" uuid NOT NULL,
        "position_seconds" integer NOT NULL,
        "view_counted_at" timestamptz,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cinema_watch_progress" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_cinema_watch_progress_user_title" UNIQUE ("user_id", "title_id")
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "cinema_watch_progress" ADD CONSTRAINT "FK_cinema_watch_progress_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cinema_watch_progress" ADD CONSTRAINT "FK_cinema_watch_progress_title_id" FOREIGN KEY ("title_id") REFERENCES "cinema_titles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cinema_watch_progress_title_id" ON "cinema_watch_progress" ("title_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "cinema_watch_progress"`);
    await queryRunner.query(`DROP TABLE "cinema_titles"`);
    await queryRunner.query(`DROP TYPE "cinema_titles_status_enum"`);
    await queryRunner.query(`DROP TYPE "cinema_titles_kind_enum"`);
  }
}
