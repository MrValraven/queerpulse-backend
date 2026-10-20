// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creator drafts (see the creator drafts admin contract): the event wizard,
 * the listing editor and Start a Community keep one server draft per author
 * per slot, with three stored kinds: `event`, `listing_edit`, `community`.
 *
 * The unique index on (user_id, kind, slot_key) is the slot. `revision` is the
 * save precondition: a write names the revision it read and lands only when it
 * still matches. A draft expires after 90 days; the purge job removes it.
 *
 * The author FK cascades. The two made-for FKs set null when their target
 * goes away. The table builds empty, so the file stays inside one transaction.
 */
export class AddCreatorDrafts1835000000000 implements MigrationInterface {
  name = 'AddCreatorDrafts1835000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "creator_drafts_kind_enum" AS ENUM ('event', 'listing_edit', 'community')
    `);
    await queryRunner.query(`
      CREATE TABLE "creator_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "kind" "creator_drafts_kind_enum" NOT NULL,
        "slot_key" character varying(64) NOT NULL DEFAULT '',
        "payload" jsonb NOT NULL,
        "payload_version" integer NOT NULL,
        "revision" integer NOT NULL DEFAULT 1,
        "made_for_community_id" uuid,
        "made_for_listing_id" uuid,
        "progress_done" integer,
        "progress_total" integer,
        "missing" text array,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_creator_drafts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_creator_drafts_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_creator_drafts_made_for_community" FOREIGN KEY ("made_for_community_id") REFERENCES "communities"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_creator_drafts_made_for_listing" FOREIGN KEY ("made_for_listing_id") REFERENCES "listings"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_creator_drafts_user_kind_slot" ON "creator_drafts" ("user_id", "kind", "slot_key")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_creator_drafts_kind_updated_at" ON "creator_drafts" ("kind", "updated_at" DESC, "id" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_creator_drafts_updated_at" ON "creator_drafts" ("updated_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "creator_drafts"`);
    await queryRunner.query(`DROP TYPE "creator_drafts_kind_enum"`);
  }
}
