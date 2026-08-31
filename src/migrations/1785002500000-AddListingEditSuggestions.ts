import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Suggest an edit" — a non-owner member's proposed correction to a business
 * listing, landing in a moderator-reviewable queue
 * (`GET /listings/admin/edit-suggestions`). Mirrors `AddListingReviews`
 * (1782800860000) / `AddWorkshopRsvps` (1782800780000)'s create-table shape.
 * Deliberately a new table rather than reusing `reports`: a correction
 * carries proposed-change data (`field`/`message`) with its own
 * accept/dismiss resolution model, not the reports lifecycle.
 *
 * No FK on `suggested_by_user_id`/`resolved_by_user_id` (mirrors
 * `listing_reviews.reviewer_id`) — both are a snapshot identity reference,
 * not a relationship an erasure sweep needs to cascade through.
 */
export class AddListingEditSuggestions1785002500000 implements MigrationInterface {
  name = 'AddListingEditSuggestions1785002500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "listing_edit_suggestions_status_enum" AS ENUM('pending', 'accepted', 'dismissed')`,
    );

    await queryRunner.query(`
      CREATE TABLE "listing_edit_suggestions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "suggested_by_user_id" uuid,
        "field" character varying NOT NULL,
        "message" text NOT NULL,
        "status" "listing_edit_suggestions_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by_user_id" uuid,
        CONSTRAINT "PK_listing_edit_suggestions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_listing_edit_suggestions_listing_id" ON "listing_edit_suggestions" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_edit_suggestions_status" ON "listing_edit_suggestions" ("status")`,
    );

    await queryRunner.query(
      `ALTER TABLE "listing_edit_suggestions" ADD CONSTRAINT "FK_listing_edit_suggestions_listing_id" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_edit_suggestions" DROP CONSTRAINT "FK_listing_edit_suggestions_listing_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_listing_edit_suggestions_status"`);
    await queryRunner.query(
      `DROP INDEX "IDX_listing_edit_suggestions_listing_id"`,
    );
    await queryRunner.query(`DROP TABLE "listing_edit_suggestions"`);
    await queryRunner.query(`DROP TYPE "listing_edit_suggestions_status_enum"`);
  }
}
