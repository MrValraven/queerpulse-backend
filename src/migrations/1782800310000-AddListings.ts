import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListings1782800310000 implements MigrationInterface {
  name = 'AddListings1782800310000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "listings_status_enum" AS ENUM('review', 'question', 'live')`,
    );

    // Backs `Listing.ref` (`QPL-<year>-<seq>`, e.g. "QPL-2026-0007") — a
    // dedicated sequence so ref allocation is atomic/monotonic and never
    // needs a retry loop (unlike the `slug` unique-index-plus-retry pattern
    // used elsewhere), matching `ListingsService.nextRef`.
    await queryRunner.query(`CREATE SEQUENCE "listings_ref_seq" START 1`);

    await queryRunner.query(`
      CREATE TABLE "listings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ref" character varying NOT NULL,
        "slug" character varying NOT NULL,
        "owner_id" uuid NOT NULL,
        "status" "listings_status_enum" NOT NULL DEFAULT 'review',
        "path" character varying NOT NULL DEFAULT '',
        "verify" character varying NOT NULL DEFAULT '',
        "name" character varying NOT NULL,
        "cats" text array NOT NULL DEFAULT '{}',
        "hood" character varying NOT NULL DEFAULT '',
        "badge" character varying NOT NULL DEFAULT '',
        "evidence" text NOT NULL DEFAULT '',
        "price" character varying NOT NULL DEFAULT '',
        "blurb" character varying(140) NOT NULL DEFAULT '',
        "tagline" character varying NOT NULL DEFAULT '',
        "what_it_is" jsonb NOT NULL DEFAULT '[]',
        "tags" text array NOT NULL DEFAULT '{}',
        "good_for" text array NOT NULL DEFAULT '{}',
        "langs" text array NOT NULL DEFAULT '{}',
        "address" text NOT NULL DEFAULT '',
        "geocoded" boolean NOT NULL DEFAULT false,
        "hours" jsonb NOT NULL DEFAULT '{}',
        "hours_note" text NOT NULL DEFAULT '',
        "social" jsonb NOT NULL DEFAULT '{}',
        "photos" jsonb NOT NULL DEFAULT '{}',
        "alt" jsonb NOT NULL DEFAULT '{}',
        "rel" character varying NOT NULL DEFAULT '',
        "owner_name" character varying NOT NULL DEFAULT '',
        "owner_role" character varying NOT NULL DEFAULT '',
        "owner_bio" text NOT NULL DEFAULT '',
        "visibility" character varying NOT NULL DEFAULT '',
        "link_to_profile" boolean NOT NULL DEFAULT false,
        "contact_email" character varying NOT NULL DEFAULT '',
        "notify" text array NOT NULL DEFAULT '{}',
        "consent_outing" boolean NOT NULL DEFAULT false,
        "consent_guide" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listings" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_listings_ref" ON "listings" ("ref")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_listings_slug" ON "listings" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_owner_id" ON "listings" ("owner_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "listings" ADD CONSTRAINT "FK_listings_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" DROP CONSTRAINT "FK_listings_owner_id"`,
    );

    await queryRunner.query(`DROP TABLE "listings"`);
    await queryRunner.query(`DROP SEQUENCE "listings_ref_seq"`);
    await queryRunner.query(`DROP TYPE "listings_status_enum"`);
  }
}
