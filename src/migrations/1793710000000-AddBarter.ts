// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The skill exchange: swap listings (`barter_listings`) and the proposals
 * members make against them (`barter_proposals`).
 *
 * Both foreign keys CASCADE on the member: a listing and any proposal a member
 * made die with their account, which matches the erasure precedent set by
 * `FixCommunityOwnerAuthorErasureCascades1789900000000` for member-owned
 * content that has no meaning without its author.
 *
 * `UQ_barter_proposals_listing_proposer` is what makes a member's proposal on a
 * listing singular — `BarterService.createProposal` reactivates a declined row
 * rather than inserting a second one, and this constraint is the last word if
 * two attempts race.
 *
 * No `CREATE INDEX CONCURRENTLY` here: both tables are created empty in this
 * same migration, so the indexes are built on nothing and the whole file stays
 * inside one transaction.
 */
export class AddBarter1793710000000 implements MigrationInterface {
  name = 'AddBarter1793710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "barter_listings_category_enum" AS ENUM
        ('creative', 'tech', 'legal', 'care', 'food', 'body')
    `);
    await queryRunner.query(`
      CREATE TYPE "barter_listings_mode_enum" AS ENUM
        ('offering', 'seeking', 'both')
    `);
    await queryRunner.query(`
      CREATE TYPE "barter_listings_status_enum" AS ENUM ('open', 'closed')
    `);
    await queryRunner.query(`
      CREATE TYPE "barter_proposals_status_enum" AS ENUM
        ('pending', 'accepted', 'declined')
    `);

    await queryRunner.query(`
      CREATE TABLE "barter_listings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_id" uuid NOT NULL,
        "category" "barter_listings_category_enum" NOT NULL,
        "mode" "barter_listings_mode_enum" NOT NULL,
        "offer" character varying(160) NOT NULL DEFAULT '',
        "want" character varying(160) NOT NULL DEFAULT '',
        "offer_detail" text NOT NULL DEFAULT '',
        "want_detail" text NOT NULL DEFAULT '',
        "tags" text array NOT NULL DEFAULT '{}',
        "status" "barter_listings_status_enum" NOT NULL DEFAULT 'open',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_barter_listings" PRIMARY KEY ("id"),
        CONSTRAINT "FK_barter_listings_owner" FOREIGN KEY ("owner_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_barter_listings_owner_id"
        ON "barter_listings" ("owner_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_barter_listings_category"
        ON "barter_listings" ("category")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_barter_listings_mode" ON "barter_listings" ("mode")
    `);
    // The board's default read is "open listings, newest first" — this is the
    // composite that serves it without a sort.
    await queryRunner.query(`
      CREATE INDEX "IDX_barter_listings_status_created_at"
        ON "barter_listings" ("status", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "barter_proposals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "proposer_id" uuid NOT NULL,
        "message" text NOT NULL,
        "status" "barter_proposals_status_enum" NOT NULL DEFAULT 'pending',
        "decided_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_barter_proposals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_barter_proposals_listing_proposer"
          UNIQUE ("listing_id", "proposer_id"),
        CONSTRAINT "FK_barter_proposals_listing" FOREIGN KEY ("listing_id")
          REFERENCES "barter_listings"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_barter_proposals_proposer" FOREIGN KEY ("proposer_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_barter_proposals_listing_id"
        ON "barter_proposals" ("listing_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_barter_proposals_proposer_id"
        ON "barter_proposals" ("proposer_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "barter_proposals"`);
    await queryRunner.query(`DROP TABLE "barter_listings"`);
    await queryRunner.query(`DROP TYPE "barter_proposals_status_enum"`);
    await queryRunner.query(`DROP TYPE "barter_listings_status_enum"`);
    await queryRunner.query(`DROP TYPE "barter_listings_mode_enum"`);
    await queryRunner.query(`DROP TYPE "barter_listings_category_enum"`);
  }
}
