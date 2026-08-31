import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `listing_moderation_events` — the moderation audit trail (item #16)
 * and reason-capture (item #15) backing `GET /listings/admin/:ref/history`
 * (see `ListingModerationEvent` entity for the full field-by-field
 * rationale). Written by `ListingsService` on every moderator-initiated
 * action: a direct or bulk status change, a hard removal, a question asked,
 * or a question answered.
 *
 * `listing_id` is a plain indexed uuid with deliberately NO foreign key to
 * `listings` (mirrors `listing_reviews.listing_id`'s precedent) so a
 * moderator hard-deleting a listing never cascades away the very `removed`
 * event that documents the deletion. `actor_id` DOES get a foreign key to
 * `users(id)` — `ON DELETE SET NULL`, mirroring `AddUserRefForeignKeys`'s
 * convention for user references — so an account erasure nulls the actor out
 * while the audit row survives.
 */
export class CreateListingModerationEvents1785902000000 implements MigrationInterface {
  name = 'CreateListingModerationEvents1785902000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "listing_moderation_events_action_enum" AS ENUM(` +
        `'status_changed', 'removed', 'question_asked', 'answered', 'bulk_status')`,
    );

    await queryRunner.query(`
      CREATE TABLE "listing_moderation_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "actor_id" uuid,
        "action" "listing_moderation_events_action_enum" NOT NULL,
        "from_status" character varying,
        "to_status" character varying,
        "reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_moderation_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_listing_moderation_events_listing_id" ON "listing_moderation_events" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_moderation_events_actor_id" ON "listing_moderation_events" ("actor_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "listing_moderation_events" ADD CONSTRAINT "FK_listing_moderation_events_actor_id"
        FOREIGN KEY ("actor_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_moderation_events" DROP CONSTRAINT "FK_listing_moderation_events_actor_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_moderation_events_actor_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_moderation_events_listing_id"`,
    );
    await queryRunner.query(`DROP TABLE "listing_moderation_events"`);
    await queryRunner.query(
      `DROP TYPE "listing_moderation_events_action_enum"`,
    );
  }
}
