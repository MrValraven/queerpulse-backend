import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Creates the single sender namespace used by mailboxes. Exactly one owner
 * column is set and it must match `kind`, which the CHECK enforces so a row
 * can never claim to be a listing while pointing at a company. One partial
 * unique index per owner column keeps it at one identity per thing.
 *
 * The backfill mints a `profile` identity for every existing user. Doing it
 * here means later migrations can set `conversation_participants.identity_id`
 * to NOT NULL without a "null means me" convention that every read would have
 * to remember.
 */
export class AddIdentities1821200000000 implements MigrationInterface {
  name = 'AddIdentities1821200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "identities_kind_enum" AS ENUM ('profile', 'subprofile', 'listing', 'company')
    `);
    await queryRunner.query(`
      CREATE TABLE "identities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" "identities_kind_enum" NOT NULL,
        "user_id" uuid,
        "subprofile_id" uuid,
        "listing_id" uuid,
        "company_id" uuid,
        "should_show_staff_names" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_identities" PRIMARY KEY ("id"),
        CONSTRAINT "FK_identities_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_identities_subprofile" FOREIGN KEY ("subprofile_id")
          REFERENCES "subprofiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_identities_listing" FOREIGN KEY ("listing_id")
          REFERENCES "listings"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_identities_company" FOREIGN KEY ("company_id")
          REFERENCES "companies"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_identities_exactly_one_owner" CHECK (
          (CASE WHEN "user_id"       IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "subprofile_id" IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "listing_id"    IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "company_id"    IS NULL THEN 0 ELSE 1 END) = 1
        ),
        CONSTRAINT "CHK_identities_owner_matches_kind" CHECK (
          ("kind" = 'profile'    AND "user_id"       IS NOT NULL) OR
          ("kind" = 'subprofile' AND "subprofile_id" IS NOT NULL) OR
          ("kind" = 'listing'    AND "listing_id"    IS NOT NULL) OR
          ("kind" = 'company'    AND "company_id"    IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_identities_kind" ON "identities" ("kind")`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_identities_user" ON "identities" ("user_id") WHERE "user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_identities_subprofile" ON "identities" ("subprofile_id") WHERE "subprofile_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_identities_listing" ON "identities" ("listing_id") WHERE "listing_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_identities_company" ON "identities" ("company_id") WHERE "company_id" IS NOT NULL
    `);

    await queryRunner.query(`
      INSERT INTO "identities" ("kind", "user_id")
      SELECT 'profile', "id" FROM "users"
    `);
    await queryRunner.query(`
      INSERT INTO "identities" ("kind", "subprofile_id")
      SELECT 'subprofile', "id" FROM "subprofiles"
    `);
    await queryRunner.query(`
      INSERT INTO "identities" ("kind", "listing_id")
      SELECT 'listing', "id" FROM "listings"
    `);
    await queryRunner.query(`
      INSERT INTO "identities" ("kind", "company_id")
      SELECT 'company', "id" FROM "companies"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "identities"`);
    await queryRunner.query(`DROP TYPE "identities_kind_enum"`);
  }
}
