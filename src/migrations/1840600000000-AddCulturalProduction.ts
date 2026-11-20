// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { CULTURAL_PRODUCTION_GUIDE_SEEDS_1840600000000 } from './data/cultural-production-guides-1840600000000.seed';

/**
 * Cultural Production: the staff page at `admin/cultural-production` where
 * producers collect event ideas, assign tasks to each other and keep event
 * guides. Six new tables (`cultural_ideas`, `cultural_idea_backers`,
 * `cultural_idea_comments`, `cultural_guides`, `cultural_tasks`,
 * `cultural_task_assignees`), four starter guides seeded from the frozen data
 * in `./data/cultural-production-guides-1840600000000.seed.ts`, and the
 * `cultural_task_assigned` and `cultural_task_batch_assigned` notification
 * labels.
 *
 * The default migration transaction stays, as in
 * AddLeadAssignees1840300000000: on Postgres 12+ `ALTER TYPE ... ADD VALUE`
 * may run inside the wrapping transaction as long as no statement in that
 * transaction uses the new label, and nothing here does. The label appends run
 * last.
 *
 * Every seeded section and step gets a fresh `randomUUID()` id, so the stored
 * guides share no ids with the frontend demo copy.
 *
 * Indexes and the keys they back:
 * - `IDX_cultural_task_assignees_user_id` serves "Assigned to me", the badge,
 *   the access-loss delete and the cascade from `users`; the composite
 *   primary keys serve every per-row read.
 * - `IDX_cultural_tasks_status_due_on` serves the open-task sort and the
 *   badge's status and day filter.
 * - The partial author, updater, assigner, idea and guide indexes back their
 *   `ON DELETE SET NULL` keys (the leads convention).
 * - `IDX_cultural_idea_comments_idea_created_at` serves the comment thread and
 *   `IDX_cultural_guides_event_type_locale` serves the guides list order.
 *
 * Every table is new, so each index builds inside the migration transaction.
 */
export class AddCulturalProduction1840600000000 implements MigrationInterface {
  name = 'AddCulturalProduction1840600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "cultural_ideas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying(160) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "event_type" character varying(32) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'new',
        "author_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cultural_ideas" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_cultural_ideas_title" CHECK (char_length(btrim("title")) >= 1),
        CONSTRAINT "CHK_cultural_ideas_description" CHECK (char_length("description") <= 4000),
        CONSTRAINT "CHK_cultural_ideas_event_type" CHECK ("event_type" IN ('board_game_night', 'quiz_night', 'music_night', 'film_night', 'workshop', 'talk', 'party', 'other')),
        CONSTRAINT "CHK_cultural_ideas_status" CHECK ("status" IN ('new', 'exploring', 'planned', 'parked')),
        CONSTRAINT "FK_cultural_ideas_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_ideas_created_at" ON "cultural_ideas" ("created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_ideas_author_id" ON "cultural_ideas" ("author_id") WHERE "author_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "cultural_idea_backers" (
        "idea_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cultural_idea_backers" PRIMARY KEY ("idea_id", "user_id"),
        CONSTRAINT "FK_cultural_idea_backers_idea" FOREIGN KEY ("idea_id") REFERENCES "cultural_ideas"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_cultural_idea_backers_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_idea_backers_user_id" ON "cultural_idea_backers" ("user_id")`,
    );

    await queryRunner.query(
      `CREATE TABLE "cultural_idea_comments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "idea_id" uuid NOT NULL,
        "author_id" uuid,
        "body" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cultural_idea_comments" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_cultural_idea_comments_body" CHECK (char_length(btrim("body")) >= 1 AND char_length("body") <= 2000),
        CONSTRAINT "FK_cultural_idea_comments_idea" FOREIGN KEY ("idea_id") REFERENCES "cultural_ideas"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_cultural_idea_comments_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_idea_comments_idea_created_at" ON "cultural_idea_comments" ("idea_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_idea_comments_author_id" ON "cultural_idea_comments" ("author_id") WHERE "author_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "cultural_guides" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying(160) NOT NULL,
        "event_type" character varying(32) NOT NULL,
        "locale" character varying(2) NOT NULL,
        "summary" character varying(500) NOT NULL DEFAULT '',
        "sections" jsonb NOT NULL DEFAULT '[]',
        "revision" integer NOT NULL DEFAULT 1,
        "author_id" uuid,
        "updated_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cultural_guides" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_cultural_guides_title" CHECK (char_length(btrim("title")) >= 1),
        CONSTRAINT "CHK_cultural_guides_event_type" CHECK ("event_type" IN ('board_game_night', 'quiz_night', 'music_night', 'film_night', 'workshop', 'talk', 'party', 'other')),
        CONSTRAINT "CHK_cultural_guides_locale" CHECK ("locale" IN ('en', 'pt')),
        CONSTRAINT "CHK_cultural_guides_sections" CHECK (CASE WHEN jsonb_typeof("sections") = 'array' THEN jsonb_array_length("sections") <= 30 ELSE false END),
        CONSTRAINT "CHK_cultural_guides_revision" CHECK ("revision" >= 1),
        CONSTRAINT "FK_cultural_guides_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_cultural_guides_updated_by" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_guides_event_type_locale" ON "cultural_guides" ("event_type", "locale")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_guides_author_id" ON "cultural_guides" ("author_id") WHERE "author_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_guides_updated_by_id" ON "cultural_guides" ("updated_by_id") WHERE "updated_by_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "cultural_tasks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying(160) NOT NULL,
        "notes" text NOT NULL DEFAULT '',
        "status" character varying(16) NOT NULL DEFAULT 'todo',
        "due_on" date,
        "event_on" date,
        "idea_id" uuid,
        "guide_id" uuid,
        "author_id" uuid,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cultural_tasks" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_cultural_tasks_title" CHECK (char_length(btrim("title")) >= 1),
        CONSTRAINT "CHK_cultural_tasks_notes" CHECK (char_length("notes") <= 4000),
        CONSTRAINT "CHK_cultural_tasks_status" CHECK ("status" IN ('todo', 'doing', 'done')),
        CONSTRAINT "CHK_cultural_tasks_completed" CHECK (("status" = 'done') = ("completed_at" IS NOT NULL)),
        CONSTRAINT "FK_cultural_tasks_idea" FOREIGN KEY ("idea_id") REFERENCES "cultural_ideas"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_cultural_tasks_guide" FOREIGN KEY ("guide_id") REFERENCES "cultural_guides"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_cultural_tasks_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_tasks_status_due_on" ON "cultural_tasks" ("status", "due_on")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_tasks_idea_id" ON "cultural_tasks" ("idea_id") WHERE "idea_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_tasks_guide_id" ON "cultural_tasks" ("guide_id") WHERE "guide_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_tasks_author_id" ON "cultural_tasks" ("author_id") WHERE "author_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "cultural_task_assignees" (
        "task_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "assigned_by_id" uuid,
        "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cultural_task_assignees" PRIMARY KEY ("task_id", "user_id"),
        CONSTRAINT "FK_cultural_task_assignees_task" FOREIGN KEY ("task_id") REFERENCES "cultural_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_cultural_task_assignees_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_cultural_task_assignees_assigned_by" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_task_assignees_user_id" ON "cultural_task_assignees" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cultural_task_assignees_assigned_by_id" ON "cultural_task_assignees" ("assigned_by_id") WHERE "assigned_by_id" IS NOT NULL`,
    );

    for (const seed of CULTURAL_PRODUCTION_GUIDE_SEEDS_1840600000000) {
      const sections = seed.sections.map((section) => ({
        id: randomUUID(),
        heading: section.heading,
        body: section.body,
        steps: section.steps.map((step) => ({
          id: randomUUID(),
          text: step.text,
          daysBefore: step.daysBefore,
        })),
      }));
      await queryRunner.query(
        `INSERT INTO "cultural_guides" ("id", "title", "event_type", "locale", "summary", "sections", "revision", "author_id", "updated_by_id")
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, NULL, NULL)`,
        [
          seed.id,
          seed.title,
          seed.eventType,
          seed.locale,
          seed.summary,
          JSON.stringify(sections),
        ],
      );
    }

    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'cultural_task_assigned'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'cultural_task_batch_assigned'`,
    );
  }

  /**
   * The `cultural_task_assigned` and `cultural_task_batch_assigned` labels
   * stay in `notifications_type_enum` after this runs: Postgres cannot drop an
   * enum value, the label is inert once no row carries it, and
   * `IF NOT EXISTS` keeps a later `up()` re-runnable.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type" IN ('cultural_task_assigned', 'cultural_task_batch_assigned')`,
    );
    await queryRunner.query(`DROP TABLE "cultural_task_assignees"`);
    await queryRunner.query(`DROP TABLE "cultural_tasks"`);
    await queryRunner.query(`DROP TABLE "cultural_idea_comments"`);
    await queryRunner.query(`DROP TABLE "cultural_idea_backers"`);
    await queryRunner.query(`DROP TABLE "cultural_ideas"`);
    await queryRunner.query(`DROP TABLE "cultural_guides"`);
  }
}
