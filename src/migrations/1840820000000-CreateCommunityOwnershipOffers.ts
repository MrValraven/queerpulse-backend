// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-514: a community ownership transfer becomes an offer the recipient
 * accepts or declines. See `CommunityOwnershipOffer`.
 *
 * Also adds the two notification labels the offer flow emits
 * (`community_ownership_offered` to the member offered the community,
 * `community_ownership_offer_declined` to the owner who offered it).
 * TRANSACTIONAL: safe inside the default wrapping transaction only because
 * nothing in this file uses the new labels.
 */
export class CreateCommunityOwnershipOffers1840820000000 implements MigrationInterface {
  name = 'CreateCommunityOwnershipOffers1840820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "community_ownership_offers_status_enum" AS ENUM('offered', 'accepted', 'declined', 'cancelled', 'expired')`,
    );
    await queryRunner.query(`
      CREATE TABLE "community_ownership_offers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "offeree_id" uuid NOT NULL,
        "offered_by_user_id" uuid,
        "from_owner_id" uuid,
        "status" "community_ownership_offers_status_enum" NOT NULL DEFAULT 'offered',
        "offered_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "responded_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_ownership_offers" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_community_ownership_offers_open" ON "community_ownership_offers" ("community_id") WHERE "status" = 'offered'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_ownership_offers_offeree_id_status" ON "community_ownership_offers" ("offeree_id", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_ownership_offers" ADD CONSTRAINT "FK_community_ownership_offers_community" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_ownership_offers" ADD CONSTRAINT "FK_community_ownership_offers_offeree" FOREIGN KEY ("offeree_id") REFERENCES "users"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_ownership_offers" ADD CONSTRAINT "FK_community_ownership_offers_offered_by" FOREIGN KEY ("offered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_ownership_offers" ADD CONSTRAINT "FK_community_ownership_offers_from_owner" FOREIGN KEY ("from_owner_id") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_ownership_offered'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_ownership_offer_declined'`,
    );
  }

  /** Drops the table and its status type. The two notification labels stay:
   * Postgres cannot drop an enum value, and a leftover label is harmless. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_ownership_offers"`);
    await queryRunner.query(
      `DROP TYPE "community_ownership_offers_status_enum"`,
    );
  }
}
