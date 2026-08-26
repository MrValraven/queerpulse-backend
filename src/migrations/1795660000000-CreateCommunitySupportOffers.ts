// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `community_support_offers` — the record behind the admin console's "Offer
 * support" button (OPS-05).
 *
 * That button has existed since the console was built and wrote nothing at
 * all: it showed a success toast with an Undo that withdrew nothing, and the
 * community never heard from anyone. This table is the offer, and the
 * community's own owner/co-owners/moderators read and answer it in their
 * mod-tools console.
 *
 * `options` is `text[]` rather than free strings or a jsonb blob: the four
 * kinds of support are a fixed, code-defined set
 * (`src/communities/community-support-options.ts`), validated against that
 * registry at the DTO boundary, and every reader has copy for exactly those
 * keys. `note` is plain text, stripped once at the write boundary by
 * `toStoredPlainText` (see `community-plain-text.ts`), so the column can never
 * hold markup for a render site to strip again.
 *
 * FK behaviour. `community_id` CASCADEs — an offer to a room that no longer
 * exists is nothing. BOTH actor columns are `ON DELETE SET NULL`, the
 * actor-FK convention this module follows and the same posture
 * `reports.assigned_moderator_id` takes: nothing here may stand in the way of
 * the account-erasure sweep, and a community keeps the offer it was made even
 * after the staff member who made it has left the platform.
 * `offered_by_name` is the write-time name snapshot that keeps the row
 * readable in exactly that case, mirroring `mod_audit_logs.target_name`.
 *
 * TRANSACTIONAL, and safely so: `CREATE TYPE` is a new type, not an
 * `ALTER TYPE ... ADD VALUE` on an existing one, so the rule the two
 * `ADD VALUE` migrations beside this one opt out for does not apply here. The
 * two enum labels this feature also needs live in their own files
 * (`1795660100000`, `1795660200000`).
 *
 * No `CREATE INDEX CONCURRENTLY`: the table is created empty here, so the
 * index builds on nothing and the file stays inside one transaction.
 */
export class CreateCommunitySupportOffers1795660000000 implements MigrationInterface {
  name = 'CreateCommunitySupportOffers1795660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_support_offers_status_enum" AS ENUM
        ('new', 'acknowledged', 'declined')
    `);
    await queryRunner.query(`
      CREATE TABLE "community_support_offers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "offered_by_user_id" uuid,
        "offered_by_name" character varying,
        "options" text array NOT NULL DEFAULT '{}',
        "note" text,
        "status" "community_support_offers_status_enum" NOT NULL DEFAULT 'new',
        "responded_by_user_id" uuid,
        "responded_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_support_offers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_community_support_offers_community" FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_support_offers_offered_by" FOREIGN KEY ("offered_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_community_support_offers_responded_by" FOREIGN KEY ("responded_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    // Every read of this table is "the offers for one community, newest
    // first", and the admin write checks "is one still unanswered" against the
    // same prefix. `created_at DESC, id DESC` matches the reader's order
    // exactly; the decorator API cannot express column sort order, which is
    // why the DDL lives here rather than on the entity.
    await queryRunner.query(`
      CREATE INDEX "IDX_community_support_offers_community_id"
        ON "community_support_offers" ("community_id", "created_at" DESC, "id" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_support_offers"`);
    await queryRunner.query(`DROP TYPE "community_support_offers_status_enum"`);
  }
}
