// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateListingOwnerOffers1821300000000 implements MigrationInterface {
  name = 'CreateListingOwnerOffers1821300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "listing_owner_offers_status_enum" AS ENUM('offered', 'accepted', 'declined', 'revoked')`,
    );
    await queryRunner.query(`
      CREATE TABLE "listing_owner_offers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "offeree_id" uuid NOT NULL,
        "offered_by_user_id" uuid,
        "note" text,
        "status" "listing_owner_offers_status_enum" NOT NULL DEFAULT 'offered',
        "offered_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "responded_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_owner_offers" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_listing_owner_offers_open" ON "listing_owner_offers" ("listing_id") WHERE "status" = 'offered'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_owner_offers_offeree_id_status" ON "listing_owner_offers" ("offeree_id", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_owner_offers" ADD CONSTRAINT "FK_listing_owner_offers_listing" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_owner_offers" ADD CONSTRAINT "FK_listing_owner_offers_offeree" FOREIGN KEY ("offeree_id") REFERENCES "users"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_owner_offers" ADD CONSTRAINT "FK_listing_owner_offers_offered_by" FOREIGN KEY ("offered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "listing_owner_offers"`);
    await queryRunner.query(`DROP TYPE "listing_owner_offers_status_enum"`);
  }
}
