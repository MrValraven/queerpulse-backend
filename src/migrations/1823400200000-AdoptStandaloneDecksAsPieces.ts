// Applied at backend boot while pending: `ensureDatabaseSchema` (called from
// `src/main.ts`) runs every pending migration at startup unless
// `AUTO_RUN_MIGRATIONS=false` is set. To apply it by hand instead, set that
// flag, check `pnpm run typeorm migration:show`, then `pnpm run migration:run`.
// This one writes data (it inserts a desk piece for every standalone deck),
// so count the decks it will adopt before a boot applies it.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes every deck a desk piece. Until now a deck could live only in the
 * separate deck registry (`magazine_deck` with no `magazine_piece.deck_id`
 * pointing at it), which the desk had to read beside its pieces. New deck
 * pieces now create their own deck (`MagazinePieceService.createPiece`), so
 * this adopts the decks made before that.
 *
 * For each standalone deck it inserts one piece:
 * - `format` deck, `title` and `byline` from the deck, `deck_id` the deck.
 * - `section` from the deck, or the first seeded `magazine_section` when the
 *   deck has none (`magazine_piece.section` is NOT NULL and the desk groups
 *   by it).
 * - `stage` `drafting` with no `published_at`, `published` once it is live
 *   now, and `ready` while it is scheduled for later. That matches the rest
 *   of the desk: only content a reader can open right now reads `published`
 *   (`publishPiece`, `shipIssue`).
 * - `issue_id` NULL, so adopted decks land in Unassigned.
 * - `editor_id` (NOT NULL): the earliest-created holder of the
 *   `magazine_editor` staff role, else the earliest admin. Within each group
 *   an active account wins over a suspended or deactivated one, so adopted
 *   decks never land on someone who cannot open the desk. With no editor and
 *   no admin at all it inserts nothing.
 * - `created_at` and `updated_at` the deck's own `created_at`, so the desk
 *   ages the piece from when the deck was really started.
 *
 * Identifying rule for `down`: every adopted piece gets one
 * `magazine_piece_event` with `action = 'imported'`, `actor_id` NULL (the
 * desk shows it as System) and `detail = ADOPTION_MARKER`, dated at the
 * deck's `created_at`, so the desk activity feed keeps its real recent
 * history on top. No code path writes that detail. `down` removes only
 * adopted pieces nobody has touched since: still a deck piece on the same
 * deck, `updated_at` unchanged since adoption, and no other event, message,
 * payment, letter or correction. A piece an editor has worked on is real
 * desk work by then and stays. The decks themselves are never touched.
 */
const ADOPTION_MARKER = 'standalone deck backfill 1823400200000';

export class AdoptStandaloneDecksAsPieces1823400200000 implements MigrationInterface {
  name = 'AdoptStandaloneDecksAsPieces1823400200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      WITH "chosen_editor" AS (
        SELECT "candidate"."id"
        FROM (
          SELECT
            "u"."id",
            "u"."created_at",
            "u"."status",
            "u"."role" = 'admin' AS "is_admin",
            EXISTS (
              SELECT 1 FROM "user_staff_roles" "grant"
              WHERE "grant"."user_id" = "u"."id"
                AND "grant"."role" = 'magazine_editor'
            ) AS "is_magazine_editor"
          FROM "users" "u"
        ) "candidate"
        WHERE "candidate"."is_magazine_editor" OR "candidate"."is_admin"
        ORDER BY
          "candidate"."is_magazine_editor" DESC,
          ("candidate"."status" = 'active') DESC,
          "candidate"."created_at" ASC,
          "candidate"."id" ASC
        LIMIT 1
      ),
      "fallback_section" AS (
        SELECT "section"."name"
        FROM "magazine_section" "section"
        ORDER BY "section"."order_index" ASC
        LIMIT 1
      ),
      "adopted" AS (
        INSERT INTO "magazine_piece" (
          "format", "title", "section", "stage", "editor_id", "byline",
          "issue_id", "deck_id", "created_at", "updated_at"
        )
        SELECT
          'deck',
          "deck"."title",
          COALESCE(
            NULLIF(btrim("deck"."section"), ''),
            (SELECT "name" FROM "fallback_section"),
            'Features'
          ),
          CASE
            WHEN "deck"."published_at" IS NULL THEN 'drafting'
            WHEN "deck"."published_at" <= now() THEN 'published'
            ELSE 'ready'
          END,
          "chosen_editor"."id",
          "deck"."byline",
          NULL,
          "deck"."id",
          "deck"."created_at",
          "deck"."created_at"
        FROM "magazine_deck" "deck"
        CROSS JOIN "chosen_editor"
        WHERE NOT EXISTS (
          SELECT 1 FROM "magazine_piece" "piece"
          WHERE "piece"."deck_id" = "deck"."id"
        )
        RETURNING "id", "created_at"
      )
      INSERT INTO "magazine_piece_event" (
        "piece_id", "actor_id", "action", "detail", "created_at"
      )
      SELECT "adopted"."id", NULL, 'imported', $1, "adopted"."created_at"
      FROM "adopted"
      `,
      [ADOPTION_MARKER],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // One statement: the untouched set is computed once, then its pieces and
    // their marker events are deleted together.
    await queryRunner.query(
      `
      WITH "untouched" AS (
        SELECT "piece"."id"
        FROM "magazine_piece" "piece"
        JOIN "magazine_piece_event" "marker"
          ON "marker"."piece_id" = "piece"."id"
         AND "marker"."action" = 'imported'
         AND "marker"."detail" = $1
        WHERE "piece"."format" = 'deck'
          AND "piece"."deck_id" IS NOT NULL
          AND "piece"."article_id" IS NULL
          AND "piece"."updated_at" = "marker"."created_at"
          AND NOT EXISTS (
            SELECT 1 FROM "magazine_piece_event" "other_event"
            WHERE "other_event"."piece_id" = "piece"."id"
              AND "other_event"."id" <> "marker"."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "magazine_piece_message" "message"
            WHERE "message"."piece_id" = "piece"."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "magazine_payment" "payment"
            WHERE "payment"."piece_id" = "piece"."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "magazine_letter" "letter"
            WHERE "letter"."piece_id" = "piece"."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "magazine_correction" "correction"
            WHERE "correction"."piece_id" = "piece"."id"
          )
      ),
      "removed_events" AS (
        DELETE FROM "magazine_piece_event" "event"
        USING "untouched"
        WHERE "event"."piece_id" = "untouched"."id"
          AND "event"."action" = 'imported'
          AND "event"."detail" = $1
        RETURNING "event"."id"
      )
      DELETE FROM "magazine_piece" "piece"
      USING "untouched"
      WHERE "piece"."id" = "untouched"."id"
      `,
      [ADOPTION_MARKER],
    );
  }
}
