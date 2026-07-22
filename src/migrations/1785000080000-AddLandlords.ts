// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLandlords1785000080000 implements MigrationInterface {
  name = 'AddLandlords1785000080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "landlords_status_enum" AS ENUM('review', 'live')`,
    );
    await queryRunner.query(
      `CREATE TYPE "landlord_intro_requests_status_enum" AS ENUM('pending', 'accepted', 'declined')`,
    );

    await queryRunner.query(`
      CREATE TABLE "landlords" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "status" "landlords_status_enum" NOT NULL DEFAULT 'review',
        "submitted_by_user_id" uuid,
        "name" character varying NOT NULL,
        "hood" character varying NOT NULL DEFAULT '',
        "photo" character varying NOT NULL DEFAULT '',
        "tagline" character varying NOT NULL DEFAULT '',
        "note" character varying NOT NULL DEFAULT '',
        "about" text array NOT NULL DEFAULT '{}',
        "areas" text array NOT NULL DEFAULT '{}',
        "renting_note" text NOT NULL DEFAULT '',
        "stats" jsonb NOT NULL DEFAULT '[]',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_landlords" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "landlord_recommendations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "landlord_id" uuid NOT NULL,
        "author_user_id" uuid NOT NULL,
        "stars" integer NOT NULL,
        "text" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_landlord_recommendations" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "landlord_intro_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "landlord_id" uuid NOT NULL,
        "user_id" uuid,
        "name" character varying NOT NULL,
        "note" text,
        "contact_email" character varying,
        "status" "landlord_intro_requests_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_landlord_intro_requests" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_landlords_slug" ON "landlords" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_landlords_status" ON "landlords" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_landlords_submitted_by_user_id" ON "landlords" ("submitted_by_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_landlord_recommendations_landlord_id" ON "landlord_recommendations" ("landlord_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_landlord_recommendations_author_user_id" ON "landlord_recommendations" ("author_user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_landlord_recommendations_author" ON "landlord_recommendations" ("landlord_id", "author_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_landlord_intro_requests_landlord_id" ON "landlord_intro_requests" ("landlord_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_landlord_intro_requests_status" ON "landlord_intro_requests" ("status")`,
    );

    await queryRunner.query(
      `ALTER TABLE "landlords" ADD CONSTRAINT "FK_landlords_submitted_by_user_id" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_recommendations" ADD CONSTRAINT "FK_landlord_recommendations_landlord_id" FOREIGN KEY ("landlord_id") REFERENCES "landlords"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_recommendations" ADD CONSTRAINT "FK_landlord_recommendations_author_user_id" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" ADD CONSTRAINT "FK_landlord_intro_requests_landlord_id" FOREIGN KEY ("landlord_id") REFERENCES "landlords"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" DROP CONSTRAINT "FK_landlord_intro_requests_landlord_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_recommendations" DROP CONSTRAINT "FK_landlord_recommendations_author_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_recommendations" DROP CONSTRAINT "FK_landlord_recommendations_landlord_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlords" DROP CONSTRAINT "FK_landlords_submitted_by_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "landlord_intro_requests"`);
    await queryRunner.query(`DROP TABLE "landlord_recommendations"`);
    await queryRunner.query(`DROP TABLE "landlords"`);
    await queryRunner.query(`DROP TYPE "landlord_intro_requests_status_enum"`);
    await queryRunner.query(`DROP TYPE "landlords_status_enum"`);
  }
}
