import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  ROADMAP_HERO_STATS,
  ROADMAP_IDEAS,
  ROADMAP_ITEMS,
} from '../roadmap/roadmap.seed';
import { RoadmapIdeaStatus } from '../roadmap/entities/roadmap-idea.entity';

/**
 * Adds the `roadmap` module's schema backing `/about/roadmap`:
 *
 * - `roadmap_items` — shipped/building/planned cards (one table, keyed by
 *   `column`, since the three card shapes mostly overlap — see the entity).
 * - `roadmap_ideas` — member-submitted feature ideas ("Top ideas" + a
 *   pending-review queue). `submitted_by_id` FK is `ON DELETE SET NULL`
 *   (nullable — a seeded/anonymised idea has no submitter, and an idea must
 *   outlive its submitter's account erasure; mirrors `topic_post.author_id`
 *   in `AddTopicPostAuthor` and `forum_post_edit.editor_id`).
 * - `roadmap_votes` — one row per member vote on a planned item or an idea,
 *   unique per (member, target), so double-voting is a constraint violation
 *   rather than app-level bookkeeping. `member_id` FK is `ON DELETE CASCADE`
 *   (a vote is a per-member reaction meaningless without its member, and the
 *   column is `NOT NULL`; mirrors `community_post_reactions.user_id` and
 *   `message_reactions.user_id`). `target_id` is deliberately left WITHOUT a
 *   FK — it is polymorphic (an item id OR an idea id, discriminated by
 *   `target_type`), so no single referenced table exists.
 * - `roadmap_settings` — singleton (id = 1) holding the admin-curated hero
 *   stats, mirrors `governance_overview`/`changemaker_directory_settings`.
 *
 * Seeded directly here (rather than via a separate `*.seed.ts` wired into
 * `pnpm run seed`, like `governance`/`changemakers`) from
 * `src/roadmap/roadmap.seed.ts`, itself transcribed from the frontend's
 * `queerpulse/src/features/marketing/roadmap.data.ts`, so `/about/roadmap`
 * renders unchanged the moment it's wired to `GET /roadmap`. Seeded ideas are
 * inserted as `published` (they mirror the frontend's already-live
 * `TOP_IDEAS`), not `pending` review.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class CreateRoadmap1785002000000 implements MigrationInterface {
  name = 'CreateRoadmap1785002000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- enums -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TYPE "roadmap_items_column_enum" AS ENUM ('shipped', 'building', 'planned')
    `);
    await queryRunner.query(`
      CREATE TYPE "roadmap_ideas_status_enum" AS ENUM ('pending', 'published', 'dismissed')
    `);
    await queryRunner.query(`
      CREATE TYPE "roadmap_votes_target_type_enum" AS ENUM ('item', 'idea')
    `);

    // --- roadmap_items -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "roadmap_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "column" "roadmap_items_column_enum" NOT NULL,
        "category" character varying NOT NULL,
        "name" character varying NOT NULL,
        "description" text NOT NULL,
        "date" character varying,
        "stage" character varying,
        "eta" character varying,
        "progress" integer,
        "votes" integer NOT NULL DEFAULT 0,
        "requested" boolean NOT NULL DEFAULT false,
        "hot" boolean NOT NULL DEFAULT false,
        "sort_order" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roadmap_items" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_roadmap_items_column_sort" ON "roadmap_items" ("column", "sort_order")`,
    );

    // --- roadmap_ideas -------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "roadmap_ideas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "text" character varying NOT NULL,
        "status" "roadmap_ideas_status_enum" NOT NULL DEFAULT 'pending',
        "votes" integer NOT NULL DEFAULT 0,
        "submitted_by_id" uuid,
        "sort_order" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roadmap_ideas" PRIMARY KEY ("id"),
        CONSTRAINT "FK_roadmap_ideas_submitted_by_id"
          FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_roadmap_ideas_status_sort" ON "roadmap_ideas" ("status", "sort_order")`,
    );

    // --- roadmap_votes -------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "roadmap_votes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "member_id" uuid NOT NULL,
        "target_type" "roadmap_votes_target_type_enum" NOT NULL,
        "target_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roadmap_votes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_roadmap_votes_member_target" UNIQUE ("member_id", "target_type", "target_id"),
        CONSTRAINT "FK_roadmap_votes_member_id"
          FOREIGN KEY ("member_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    // Backs the per-target live-vote count (`RoadmapService.liveVoteCounts`:
    // `WHERE target_type = ? AND target_id IN (...)`). The unique constraint's
    // leading column is `member_id`, so it can't serve this lookup; without a
    // dedicated `(target_type, target_id)` index every roadmap read
    // sequentially scans `roadmap_votes`.
    await queryRunner.query(
      `CREATE INDEX "IDX_roadmap_votes_target" ON "roadmap_votes" ("target_type", "target_id")`,
    );

    // --- roadmap_settings ------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "roadmap_settings" (
        "id" integer NOT NULL DEFAULT 1,
        "hero_stats" jsonb NOT NULL DEFAULT '[]',
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roadmap_settings" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_roadmap_settings_singleton" CHECK ("id" = 1)
      )
    `);

    // --- seed --------------------------------------------------------------
    for (const item of ROADMAP_ITEMS) {
      await queryRunner.query(
        `INSERT INTO "roadmap_items"
           ("column", "category", "name", "description", "date", "stage", "eta", "progress", "votes", "requested", "hot", "sort_order")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          item.column,
          item.category,
          item.name,
          item.description,
          item.date ?? null,
          item.stage ?? null,
          item.eta ?? null,
          item.progress ?? null,
          item.votes ?? 0,
          item.requested ?? false,
          item.hot ?? false,
          item.sortOrder,
        ],
      );
    }

    for (const idea of ROADMAP_IDEAS) {
      await queryRunner.query(
        `INSERT INTO "roadmap_ideas" ("text", "status", "votes", "sort_order")
         VALUES ($1, $2, $3, $4)`,
        [idea.text, RoadmapIdeaStatus.Published, idea.votes, idea.sortOrder],
      );
    }

    await queryRunner.query(
      `INSERT INTO "roadmap_settings" ("id", "hero_stats") VALUES (1, $1)`,
      [JSON.stringify(ROADMAP_HERO_STATS)],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "roadmap_settings"`);
    await queryRunner.query(`DROP INDEX "IDX_roadmap_ideas_status_sort"`);
    await queryRunner.query(`DROP TABLE "roadmap_ideas"`);
    await queryRunner.query(`DROP INDEX "IDX_roadmap_items_column_sort"`);
    await queryRunner.query(`DROP TABLE "roadmap_items"`);
    await queryRunner.query(`DROP INDEX "IDX_roadmap_votes_target"`);
    await queryRunner.query(`DROP TABLE "roadmap_votes"`);
    await queryRunner.query(`DROP TYPE "roadmap_votes_target_type_enum"`);
    await queryRunner.query(`DROP TYPE "roadmap_ideas_status_enum"`);
    await queryRunner.query(`DROP TYPE "roadmap_items_column_enum"`);
  }
}
