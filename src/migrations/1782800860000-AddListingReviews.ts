import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListingReviews1782800860000 implements MigrationInterface {
  name = 'AddListingReviews1782800860000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "listing_reviews" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "reviewer_id" uuid,
        "reviewer_name" character varying NOT NULL,
        "byline" character varying NOT NULL DEFAULT '',
        "stars" integer NOT NULL,
        "text" text NOT NULL,
        "helpful" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_reviews" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_reviews_listing_id" ON "listing_reviews" ("listing_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_reviews" ADD CONSTRAINT "FK_listing_reviews_listing_id" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_reviews" DROP CONSTRAINT "FK_listing_reviews_listing_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_listing_reviews_listing_id"`);
    await queryRunner.query(`DROP TABLE "listing_reviews"`);
  }
}
