import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two-sided BLIND housing reviews gated on a completed viewing (P2.4). Each
 * party may review the other exactly once per viewing (composite unique index);
 * blindness + aggregate rating are computed on the read path, so this table
 * stores only the raw submission (rating, text, submitted_at) — never a
 * "revealed" flag or a stored average.
 *
 * Additive — new enum + table only.
 */
export class AddHousingReviews1788200100000 implements MigrationInterface {
  name = 'AddHousingReviews1788200100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "housing_review_author_role_enum" AS ENUM('requester', 'lister')`,
    );

    await queryRunner.query(`
      CREATE TABLE "housing_reviews" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "viewing_id" uuid NOT NULL,
        "listing_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "subject_id" uuid NOT NULL,
        "author_role" "housing_review_author_role_enum" NOT NULL,
        "rating" integer NOT NULL,
        "text" character varying(1000) NOT NULL DEFAULT '',
        "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_housing_reviews" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_reviews_viewing_author" ON "housing_reviews" ("viewing_id", "author_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_reviews_viewing_id" ON "housing_reviews" ("viewing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_reviews_listing_id" ON "housing_reviews" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_reviews_author_id" ON "housing_reviews" ("author_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_reviews_subject_id" ON "housing_reviews" ("subject_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "housing_reviews" ADD CONSTRAINT "FK_housing_reviews_viewing_id" FOREIGN KEY ("viewing_id") REFERENCES "housing_viewings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_reviews" ADD CONSTRAINT "FK_housing_reviews_listing_id" FOREIGN KEY ("listing_id") REFERENCES "housing_listings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_reviews" ADD CONSTRAINT "FK_housing_reviews_author_id" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_reviews" ADD CONSTRAINT "FK_housing_reviews_subject_id" FOREIGN KEY ("subject_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_reviews" DROP CONSTRAINT "FK_housing_reviews_subject_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_reviews" DROP CONSTRAINT "FK_housing_reviews_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_reviews" DROP CONSTRAINT "FK_housing_reviews_listing_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_reviews" DROP CONSTRAINT "FK_housing_reviews_viewing_id"`,
    );
    await queryRunner.query(`DROP TABLE "housing_reviews"`);
    await queryRunner.query(`DROP TYPE "housing_review_author_role_enum"`);
  }
}
