import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the Admin Roadmap redesign (Task A2 of
 * `docs/superpowers/plans/2026-08-04-admin-roadmap-redesign.md`) — the schema
 * half of the frozen Appendix contract. Task A1 already added the matching
 * entity fields/classes; this migration produces the DDL for them.
 *
 * Five changes:
 *
 * 1. **`roadmap_items_column_enum` gains `'backlog'`.** The board grows a
 *    fourth column ahead of `planned`. `ALTER TYPE … ADD VALUE` is the very
 *    first statement below and nothing later in this `up()` reads or inserts
 *    the literal `'backlog'` — so, per Postgres 12+ semantics (a new enum
 *    value only can't be *used* in the transaction that added it, and this
 *    transaction never uses it), the add is safe inside the same migration
 *    transaction (`data-source.ts` runs migrations with `each`, i.e. one
 *    per-migration transaction). No two-phase split needed.
 * 2. **`roadmap_items` gains the §4.1 columns** (`public_note` … `archived`),
 *    plus four new enum types (`priority`/`confidence`/`paid_kind`/`cost`,
 *    named `roadmap_items_<column>_enum` to match the existing
 *    `roadmap_items_column_enum`/`roadmap_ideas_status_enum` convention).
 *    `owner_id` is a plain nullable FK-less-at-the-entity-level column (see
 *    the entity doc) but the migration still enforces referential integrity
 *    at the DB layer: `ON DELETE SET NULL`, matching `roadmap_ideas
 *    .submitted_by_id` — an owner leaving/erasing their account unassigns
 *    the card rather than deleting it.
 * 3. **`roadmap_ideas` gains the 5 §4.1 idea columns.** `duplicate_of_item_id`
 *    references `roadmap_items` — the idea doesn't own the item (the item
 *    would outlive the idea either way), so on the referenced item's deletion
 *    the link is cleared (`ON DELETE SET NULL`), not the idea row.
 *    `decline_reason`/`decline_note` are plain nullable `varchar`/`text` —
 *    the entity deliberately keeps `RoadmapDeclineReason` a TS union, not a
 *    Postgres enum, validated by `decline-idea.dto.ts` instead, so the closed
 *    set can grow without a migration.
 * 4. **Four new tables** — `roadmap_team_members`, `roadmap_item_comments`,
 *    `roadmap_audit_log`, `roadmap_item_dependencies` — each FK inline in its
 *    `CREATE TABLE`, per the entities' doc comments (none declare a TypeORM
 *    relation; the FK lives only in this migration):
 *    - `roadmap_team_members.user_id` is `NOT NULL UNIQUE` (a membership row,
 *      at most one per member) and `ON DELETE CASCADE` — unlike the other
 *      user refs below, `SET NULL` isn't an option (`user_id` is `NOT NULL`);
 *      losing the member means losing their roster row, same logic as
 *      `workshop_rsvps.user_id`.
 *    - `roadmap_item_comments.item_id` and both
 *      `roadmap_item_dependencies` columns are item-owned rows — a comment
 *      or a dependency edge means nothing once its item is gone — so both
 *      are `ON DELETE CASCADE`.
 *    - `roadmap_item_comments.author_id` and `roadmap_audit_log.actor_id` are
 *      nullable "who did this" refs on rows that must outlive the actor
 *      (moderation/audit history) — `ON DELETE SET NULL`, matching
 *      `roadmap_ideas.submitted_by_id`; `author_label`/`actor_label` keep the
 *      display name regardless.
 *    - `roadmap_item_dependencies` carries the frozen contract's
 *      `UQ_roadmap_item_dependencies_pair` unique pair (also serves as the
 *      by-`item_id` lookup index, `item_id` being its leading column).
 *    - `roadmap_audit_log` gets `IDX_roadmap_audit_log_created_at` as
 *      `(created_at DESC)` — the entity's own `@Index` can't express sort
 *      order (see its doc comment), so the `DESC` lives only here, backing
 *      `GET /roadmap/admin/audit?limit=&before=`'s newest-first pages.
 *    - `roadmap_item_comments` also gets a plain `item_id` index (comments
 *      are always fetched batched by item, `IN (:...ids)`, per Task A4).
 * 5. **`down()` cannot remove `'backlog'` from `roadmap_items_column_enum`**
 *    — Postgres has no `ALTER TYPE … DROP VALUE`. Left in place; acceptable
 *    (an unused enum label is inert, and no other repo migration's `down()`
 *    attempts this either — see `AddSubprofileInviteNotificationTypes`).
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddRoadmapAdminModel1785900000000 implements MigrationInterface {
  name = 'AddRoadmapAdminModel1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. roadmap_items_column_enum gains 'backlog' ----------------------
    await queryRunner.query(
      `ALTER TYPE "roadmap_items_column_enum" ADD VALUE 'backlog'`,
    );

    // --- 2. roadmap_items: new enum types + columns -------------------------
    await queryRunner.query(
      `CREATE TYPE "roadmap_items_priority_enum" AS ENUM ('P0', 'P1', 'P2', 'P3')`,
    );
    await queryRunner.query(
      `CREATE TYPE "roadmap_items_confidence_enum" AS ENUM ('likely', 'maybe', 'hoping')`,
    );
    await queryRunner.query(
      `CREATE TYPE "roadmap_items_paid_kind_enum" AS ENUM ('paid', 'volunteer')`,
    );
    await queryRunner.query(
      `CREATE TYPE "roadmap_items_cost_enum" AS ENUM ('none', 'small', 'funded', 'needs')`,
    );

    await queryRunner.query(`
      ALTER TABLE "roadmap_items"
        ADD COLUMN "public_note" character varying,
        ADD COLUMN "target_quarter" character varying,
        ADD COLUMN "priority" "roadmap_items_priority_enum" NOT NULL DEFAULT 'P2',
        ADD COLUMN "confidence" "roadmap_items_confidence_enum" NOT NULL DEFAULT 'maybe',
        ADD COLUMN "committed" boolean NOT NULL DEFAULT false,
        ADD COLUMN "is_public" boolean NOT NULL DEFAULT true,
        ADD COLUMN "notified" boolean NOT NULL DEFAULT false,
        ADD COLUMN "spike_flag" boolean NOT NULL DEFAULT false,
        ADD COLUMN "safety_status" smallint NOT NULL DEFAULT 0,
        ADD COLUMN "blocked_by" character varying,
        ADD COLUMN "blocked_why" text,
        ADD COLUMN "paid_kind" "roadmap_items_paid_kind_enum" NOT NULL DEFAULT 'volunteer',
        ADD COLUMN "weekly_hours" integer NOT NULL DEFAULT 0,
        ADD COLUMN "cost" "roadmap_items_cost_enum" NOT NULL DEFAULT 'none',
        ADD COLUMN "owner_id" uuid,
        ADD COLUMN "slips" jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN "guide" jsonb,
        ADD COLUMN "archived" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "roadmap_items" ADD CONSTRAINT "FK_roadmap_items_owner_id"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- 3. roadmap_ideas: 5 new columns -------------------------------------
    await queryRunner.query(`
      ALTER TABLE "roadmap_ideas"
        ADD COLUMN "category" character varying NOT NULL DEFAULT 'members',
        ADD COLUMN "note" text,
        ADD COLUMN "duplicate_of_item_id" uuid,
        ADD COLUMN "decline_reason" character varying,
        ADD COLUMN "decline_note" text
    `);
    await queryRunner.query(`
      ALTER TABLE "roadmap_ideas" ADD CONSTRAINT "FK_roadmap_ideas_duplicate_of_item_id"
        FOREIGN KEY ("duplicate_of_item_id") REFERENCES "roadmap_items"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- 4a. roadmap_team_members --------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "roadmap_team_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "role" character varying NOT NULL,
        "weekly_cap_hours" integer NOT NULL DEFAULT 0,
        "paid" boolean NOT NULL DEFAULT false,
        "sort_order" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_roadmap_team_members" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_roadmap_team_members_user_id" UNIQUE ("user_id"),
        CONSTRAINT "FK_roadmap_team_members_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    // --- 4b. roadmap_item_comments --------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "roadmap_item_comments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "item_id" uuid NOT NULL,
        "author_id" uuid,
        "author_label" character varying NOT NULL,
        "body" text NOT NULL,
        "hidden" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roadmap_item_comments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_roadmap_item_comments_item_id" FOREIGN KEY ("item_id")
          REFERENCES "roadmap_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_roadmap_item_comments_author_id" FOREIGN KEY ("author_id")
          REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    // Comments are always fetched batched by item (`item_id IN (:...ids)`,
    // Task A4's no-N+1 load) — never by author or hidden state alone.
    await queryRunner.query(
      `CREATE INDEX "IDX_roadmap_item_comments_item_id" ON "roadmap_item_comments" ("item_id")`,
    );

    // --- 4c. roadmap_audit_log ------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "roadmap_audit_log" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "actor_id" uuid,
        "actor_label" character varying NOT NULL,
        "action" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roadmap_audit_log" PRIMARY KEY ("id"),
        CONSTRAINT "FK_roadmap_audit_log_actor_id" FOREIGN KEY ("actor_id")
          REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    // Newest-first pages for `GET /roadmap/admin/audit?limit=&before=` and the
    // CSV export; DESC lives only here (see the entity's `@Index` doc comment).
    await queryRunner.query(
      `CREATE INDEX "IDX_roadmap_audit_log_created_at" ON "roadmap_audit_log" ("created_at" DESC)`,
    );

    // --- 4d. roadmap_item_dependencies ----------------------------------------
    await queryRunner.query(`
      CREATE TABLE "roadmap_item_dependencies" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "item_id" uuid NOT NULL,
        "depends_on_id" uuid NOT NULL,
        CONSTRAINT "PK_roadmap_item_dependencies" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_roadmap_item_dependencies_pair" UNIQUE ("item_id", "depends_on_id"),
        CONSTRAINT "FK_roadmap_item_dependencies_item_id" FOREIGN KEY ("item_id")
          REFERENCES "roadmap_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_roadmap_item_dependencies_depends_on_id" FOREIGN KEY ("depends_on_id")
          REFERENCES "roadmap_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // --- 4d ---
    await queryRunner.query(`DROP TABLE "roadmap_item_dependencies"`);

    // --- 4c ---
    await queryRunner.query(`DROP INDEX "IDX_roadmap_audit_log_created_at"`);
    await queryRunner.query(`DROP TABLE "roadmap_audit_log"`);

    // --- 4b ---
    await queryRunner.query(`DROP INDEX "IDX_roadmap_item_comments_item_id"`);
    await queryRunner.query(`DROP TABLE "roadmap_item_comments"`);

    // --- 4a ---
    await queryRunner.query(`DROP TABLE "roadmap_team_members"`);

    // --- 3 ---
    await queryRunner.query(`
      ALTER TABLE "roadmap_ideas" DROP CONSTRAINT "FK_roadmap_ideas_duplicate_of_item_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "roadmap_ideas"
        DROP COLUMN "decline_note",
        DROP COLUMN "decline_reason",
        DROP COLUMN "duplicate_of_item_id",
        DROP COLUMN "note",
        DROP COLUMN "category"
    `);

    // --- 2 ---
    await queryRunner.query(`
      ALTER TABLE "roadmap_items" DROP CONSTRAINT "FK_roadmap_items_owner_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "roadmap_items"
        DROP COLUMN "archived",
        DROP COLUMN "guide",
        DROP COLUMN "slips",
        DROP COLUMN "owner_id",
        DROP COLUMN "cost",
        DROP COLUMN "weekly_hours",
        DROP COLUMN "paid_kind",
        DROP COLUMN "blocked_why",
        DROP COLUMN "blocked_by",
        DROP COLUMN "safety_status",
        DROP COLUMN "spike_flag",
        DROP COLUMN "notified",
        DROP COLUMN "is_public",
        DROP COLUMN "committed",
        DROP COLUMN "confidence",
        DROP COLUMN "priority",
        DROP COLUMN "target_quarter",
        DROP COLUMN "public_note"
    `);
    await queryRunner.query(`DROP TYPE "roadmap_items_cost_enum"`);
    await queryRunner.query(`DROP TYPE "roadmap_items_paid_kind_enum"`);
    await queryRunner.query(`DROP TYPE "roadmap_items_confidence_enum"`);
    await queryRunner.query(`DROP TYPE "roadmap_items_priority_enum"`);

    // --- 1 ---
    // Postgres has no `ALTER TYPE … DROP VALUE`: `'backlog'` stays in
    // `roadmap_items_column_enum` after a revert. Acceptable — see the
    // class doc's point 5.
  }
}
