import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SOC-12: copy every `collection` a member made into `saved_lists`, so pointing
 * the collections UI at the saved-lists API costs nobody a collection.
 *
 * The platform grew three parallel bookmark systems. `saved_item` is the flat
 * set. `collection`/`collection_item` is a second, owner-private folder system
 * the UI was wired to. `saved_lists`/`saved_list_entries` is a third, complete
 * one with a default list, multi-membership and revocable share links, and it
 * had no frontend at all. Sharing is the whole point of a collection on this
 * platform ("here are the eight clinics I found, take a look"), so the UI moves
 * to the system that can actually do it and the folders people already made
 * come with them.
 *
 * WHAT MAPS, AND WHAT DOES NOT:
 *
 *  - `collection.name` is `varchar` (validated to 120) and `saved_lists.name`
 *    is `varchar(60)`, so a long name is TRUNCATED to 60. No collection is
 *    dropped for being long.
 *  - `collection.emoji` has no column on the other side. It is folded into the
 *    front of the name, which is exactly what the collections UI already
 *    rendered (`toDisplay` in `useCollectionsController.ts` prints
 *    `emoji + " " + name`), so the member sees the same string they saw before.
 *  - `collection.cover` is DROPPED. No UI has ever written it: the create and
 *    rename calls send `{ name }` only, so every row's `cover` is NULL.
 *  - `saved_lists` is UNIQUE on `(user_id, name)` and `collection` is not, so
 *    two folders that map to the same 60 characters for one owner are
 *    disambiguated with a " (2)", " (3)" suffix rather than one of them being
 *    lost.
 *  - A `collection_item` with no matching `saved_item` row for that owner is
 *    dropped, because `saved_list_entries.saved_item_id` is a real FK. Nothing
 *    visible is lost: the collections read already hydrated each filed item
 *    from the owner's matching `saved_item`, so an unmatched row rendered as
 *    nothing before this migration too.
 *
 * EVERY COPIED LIST IS PRIVATE. `share_token` is left NULL on every row this
 * writes. Sharing stays an act the owner performs, never a state a migration
 * puts them in: a list of queer venues is a record of where somebody goes, and
 * on this platform that can out them.
 *
 * NOTHING IS DELETED. `collection` and `collection_item` are read and left
 * exactly as they are, so this migration is safe to run before the collections
 * endpoints are retired and safe to leave in place if they never are.
 *
 * IDEMPOTENT. The mapped name is a pure function of the collection row, and
 * both inserts carry `ON CONFLICT DO NOTHING`, so running `up()` twice writes
 * nothing the second time.
 *
 * Two statements rather than one CTE chain, on purpose: a data-modifying CTE
 * and the outer query see the same snapshot in Postgres, so a single statement
 * could not join the entries back to the `saved_lists` rows it had just
 * inserted. Both statements run inside this migration's transaction, and the
 * second one re-derives the same deterministic name mapping.
 */
export class BackfillCollectionsIntoSavedLists1794740000000 implements MigrationInterface {
  name = 'BackfillCollectionsIntoSavedLists1794740000000';

  /**
   * Shared by both statements below. Produces one row per `collection` with the
   * `saved_lists` name it maps to: emoji folded in, trimmed, truncated to 60,
   * and suffixed when two collections of one owner collide on those 60
   * characters.
   */
  private static readonly MAPPING_CTE = `
    WITH "based" AS (
      SELECT
        "collection"."id"         AS "collection_id",
        "collection"."owner_id"   AS "user_id",
        "collection"."created_at" AS "created_at",
        "collection"."updated_at" AS "updated_at",
        left(
          coalesce(
            nullif(
              btrim(
                CASE
                  WHEN nullif(btrim(coalesce("collection"."emoji", '')), '') IS NULL
                    THEN "collection"."name"
                  ELSE btrim("collection"."emoji") || ' ' || "collection"."name"
                END
              ),
              ''
            ),
            'Collection'
          ),
          60
        ) AS "base_name"
      FROM "collection"
    ),
    "ranked" AS (
      SELECT
        "based".*,
        row_number() OVER (
          PARTITION BY "based"."user_id", "based"."base_name"
          ORDER BY "based"."created_at", "based"."collection_id"
        ) AS "duplicate_rank"
      FROM "based"
    ),
    "named" AS (
      SELECT
        "ranked"."collection_id",
        "ranked"."user_id",
        "ranked"."created_at",
        "ranked"."updated_at",
        CASE
          WHEN "ranked"."duplicate_rank" = 1 THEN "ranked"."base_name"
          ELSE left(
                 "ranked"."base_name",
                 60 - length(' (' || "ranked"."duplicate_rank" || ')')
               ) || ' (' || "ranked"."duplicate_rank" || ')'
        END AS "list_name"
      FROM "ranked"
    )
  `;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Step 1: one non-default saved list per collection, keeping the
    // folder's own timestamps so "updated 3 weeks ago" stays true.
    //
    // `ON CONFLICT DO NOTHING` covers the case where the mapped name is already
    // taken on the other side. In practice that is a collection literally named
    // "Saved" meeting the member's default list, and merging into it is the
    // right answer: the default list already holds every item the collection
    // could have referenced.
    await queryRunner.query(`
      ${BackfillCollectionsIntoSavedLists1794740000000.MAPPING_CTE}
      INSERT INTO "saved_lists"
        ("user_id", "name", "is_default", "share_token", "shared_at", "created_at", "updated_at")
      SELECT
        "named"."user_id",
        "named"."list_name",
        false,
        NULL::character varying,
        NULL::timestamptz,
        "named"."created_at",
        "named"."updated_at"
      FROM "named"
      ON CONFLICT DO NOTHING
    `);

    // --- Step 2: every filed item into the list its collection became.
    //
    // The join to `saved_item` is what turns the collection's polymorphic
    // `(subject_kind, subject_id)` pair into the `saved_item_id` the entry
    // table stores. `subject_type` is an enum column, so it is cast to text to
    // compare against the collection's plain varchar kind.
    //
    // `created_at` carries the filing's own timestamp across, so a migrated
    // list reads in the order the member filed things rather than all at once.
    await queryRunner.query(`
      ${BackfillCollectionsIntoSavedLists1794740000000.MAPPING_CTE}
      INSERT INTO "saved_list_entries" ("list_id", "saved_item_id", "created_at")
      SELECT
        "list"."id",
        "item"."id",
        "filed"."created_at"
      FROM "named"
      JOIN "collection_item" "filed"
        ON "filed"."collection_id" = "named"."collection_id"
      JOIN "saved_item" "item"
        ON "item"."user_id" = "named"."user_id"
       AND "item"."subject_type"::text = "filed"."subject_kind"
       AND "item"."subject_id" = "filed"."subject_id"
      JOIN "saved_lists" "list"
        ON "list"."user_id" = "named"."user_id"
       AND "list"."name" = "named"."list_name"
      ON CONFLICT ON CONSTRAINT "UQ_saved_list_entries_pair" DO NOTHING
    `);
  }

  public async down(): Promise<void> {
    // Deliberately a no-op, and it is the honest one.
    //
    // This migration only ever COPIES: `collection` and `collection_item` are
    // untouched, so a revert loses nothing by leaving the copies where they
    // are. Deleting them again would mean guessing which `saved_lists` rows
    // came from here, and a member who has since renamed a migrated list, added
    // to it, or shared it would have that work destroyed by the guess. Leaving
    // them is also what keeps `up()` re-runnable: the mapped name is
    // deterministic and both inserts skip conflicts.
  }
}
