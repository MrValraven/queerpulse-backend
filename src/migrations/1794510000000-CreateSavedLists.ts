import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `saved_lists` + `saved_list_entries` — named saved lists, and the backfill
 * that moves every existing bookmark into one without losing any of them.
 *
 * Saving was one flat set. The lists people actually want ("first date",
 * "trans-friendly healthcare", "open late") are the reason they saved the thing
 * in the first place, and they are the natural unit to hand a friend who has
 * just moved to the city.
 *
 * MANY-TO-MANY, not a `list_id` column on `saved_item`. A late-opening bar that
 * is also a good first date is genuinely both, and a single-parent model would
 * force the member to choose or to keep two copies of the same venue in step by
 * hand. See `SavedListEntry`'s docstring for the full argument.
 *
 * THE DEFAULT LIST. Each member gets exactly one (`is_default`, enforced by a
 * partial unique index) holding everything they have saved, so
 * `GET /me/saved` and the default list can never disagree and no saved item can
 * belong to no list. That is also what makes the backfill below lossless.
 *
 * THE BACKFILL, in two statements, both inside this migration's transaction so
 * a failure in the second cannot leave members holding an empty default list:
 *
 *  1. One default list named "Saved" per member who has ever saved anything,
 *     derived from `saved_item` itself (there is no separate roster of savers).
 *     `ON CONFLICT DO NOTHING` guards the index rather than assuming the table
 *     is empty.
 *  2. Every existing `saved_item` linked into its owner's new default list,
 *     joined on `user_id`, carrying the item's ORIGINAL `created_at` onto the
 *     membership row so the default list reads in the order the member actually
 *     saved things rather than all at the instant of the migration.
 *
 * Members with no saved items get no list at all, and that is correct: the
 * service mints one on their first save (`ensureDefaultListIn`). Backfilling an
 * empty list for every account on the platform would have written a row per
 * member for a feature most of them have not used.
 *
 * SHARING IS OFF FOR EVERYTHING THIS CREATES. `share_token` is NULL on every
 * backfilled row and stays NULL until an owner explicitly asks for a link. A
 * migration that turned on sharing for existing lists would have published a
 * record of where people go without anybody consenting to it, which on this
 * platform can out somebody.
 *
 * Fully transactional: two CREATE TABLEs, their indexes and constraints, and
 * two INSERT ... SELECTs. The only pre-existing table touched is `saved_item`,
 * and only by reading it plus one FK that takes a brief lock on it, so no
 * `CONCURRENTLY` two-phase split is needed.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class CreateSavedLists1794510000000 implements MigrationInterface {
  name = 'CreateSavedLists1794510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "saved_lists" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "name" character varying(60) NOT NULL,
        "is_default" boolean NOT NULL DEFAULT false,
        "share_token" character varying(64),
        "shared_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_saved_lists" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_saved_lists_user_id" ON "saved_lists" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_saved_lists_user_name"
         ON "saved_lists" ("user_id", "name")`,
    );
    // Exactly one default list per member. Partial, so the many non-default
    // lists never collide with one another.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_saved_lists_user_default"
         ON "saved_lists" ("user_id") WHERE "is_default" = true`,
    );
    // The share link's only credential, so it must resolve to at most one list.
    // Partial, so every private list (NULL token) is exempt.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_saved_lists_share_token"
         ON "saved_lists" ("share_token") WHERE "share_token" IS NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "saved_lists"
        ADD CONSTRAINT "FK_saved_lists_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "saved_list_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "list_id" uuid NOT NULL,
        "saved_item_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_saved_list_entries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_saved_list_entries_pair" UNIQUE ("list_id", "saved_item_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_saved_list_entries_list_id"
         ON "saved_list_entries" ("list_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_saved_list_entries_saved_item_id"
         ON "saved_list_entries" ("saved_item_id")`,
    );
    // Deleting a list drops its memberships and leaves the items saved;
    // unsaving an item drops it from every list. Neither can leave an orphan.
    await queryRunner.query(`
      ALTER TABLE "saved_list_entries"
        ADD CONSTRAINT "FK_saved_list_entries_list_id"
        FOREIGN KEY ("list_id") REFERENCES "saved_lists"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "saved_list_entries"
        ADD CONSTRAINT "FK_saved_list_entries_saved_item_id"
        FOREIGN KEY ("saved_item_id") REFERENCES "saved_item"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // --- Backfill, step 1: one default list per member who has saved anything.
    await queryRunner.query(`
      INSERT INTO "saved_lists" ("user_id", "name", "is_default")
      SELECT DISTINCT "user_id", 'Saved', true
      FROM "saved_item"
      ON CONFLICT DO NOTHING
    `);

    // --- Backfill, step 2: every existing bookmark into its owner's default
    // list, keeping the original save order.
    await queryRunner.query(`
      INSERT INTO "saved_list_entries" ("list_id", "saved_item_id", "created_at")
      SELECT "list"."id", "item"."id", "item"."created_at"
      FROM "saved_item" "item"
      JOIN "saved_lists" "list"
        ON "list"."user_id" = "item"."user_id" AND "list"."is_default" = true
      ON CONFLICT ON CONSTRAINT "UQ_saved_list_entries_pair" DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversible without data loss: `saved_item` is never written by this
    // migration, so dropping the two tables returns the member to exactly the
    // flat saved set they had. Only the list NAMES they invented are lost,
    // which is the unavoidable cost of reverting the feature that holds them.
    await queryRunner.query(
      `ALTER TABLE "saved_list_entries" DROP CONSTRAINT "FK_saved_list_entries_saved_item_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "saved_list_entries" DROP CONSTRAINT "FK_saved_list_entries_list_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_saved_list_entries_saved_item_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_saved_list_entries_list_id"`);
    await queryRunner.query(`DROP TABLE "saved_list_entries"`);

    await queryRunner.query(
      `ALTER TABLE "saved_lists" DROP CONSTRAINT "FK_saved_lists_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_saved_lists_share_token"`);
    await queryRunner.query(`DROP INDEX "UQ_saved_lists_user_default"`);
    await queryRunner.query(`DROP INDEX "UQ_saved_lists_user_name"`);
    await queryRunner.query(`DROP INDEX "IDX_saved_lists_user_id"`);
    await queryRunner.query(`DROP TABLE "saved_lists"`);
  }
}
