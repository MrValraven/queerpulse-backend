import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cross-device "list a business" wizard drafts (wizard overhaul item #11).
 *
 * A dedicated table rather than a `kind` on the generic `draft` table: a
 * listing draft has a server-generated uuid id (the generic table's id is a
 * caller-supplied varchar), an opaque wizard `payload`, and an unguessable
 * `resume_token` that backs the cross-device resume link — none of which the
 * generic table models. The `uuid-ossp` extension (for `uuid_generate_v4()`)
 * is already created by the Init migration.
 */
export class AddListingDrafts1785800700000 implements MigrationInterface {
  name = 'AddListingDrafts1785800700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "listing_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "resume_token" character varying NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_listing_drafts_resume_token" UNIQUE ("resume_token")
      )
    `);
    // Hot path: `GET /listing-drafts` — filter by owner, newest-edited first.
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_drafts_user_id_updated_at" ON "listing_drafts" ("user_id", "updated_at" DESC)`,
    );
    await queryRunner.query(`
      ALTER TABLE "listing_drafts" ADD CONSTRAINT "FK_listing_drafts_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_drafts" DROP CONSTRAINT "FK_listing_drafts_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_drafts_user_id_updated_at"`,
    );
    await queryRunner.query(`DROP TABLE "listing_drafts"`);
  }
}
