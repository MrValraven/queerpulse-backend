import { QueryRunner } from 'typeorm';

/**
 * The orphaned-persona repair, as one self-contained SQL statement.
 *
 * These callers run exactly this text:
 * - migration `RepairOrphanedPersonaCreators1821500400000`, once, before the
 *   new release takes traffic;
 * - migration `RerunRepairOrphanedPersonaCreators1821700000000`, queued in
 *   `src/database/pending-migrations/` for the release after the handoff
 *   ships, to catch personas orphaned during the deploy window (see that
 *   folder's README, which also gives the command for running this by hand);
 * - `repair-orphaned-persona-creators-migration.postgres.spec.ts`, against a
 *   real `_test` database.
 *
 * It lives outside `src/migrations`, which the migration glob loads whole.
 *
 * FROZEN. Both migrations execute this constant, and an applied migration
 * runs again on every fresh database (e2e, CI, a new environment), so this
 * text is frozen with `1821500400000` and `1821700000000`. Editing it would
 * silently change what those migrations do. A later schema change that
 * breaks it needs a new migration carrying its own copy of the SQL.
 *
 * An orphaned persona is one whose creator (`subprofiles.user_id`) has no
 * `subprofile_members` row while at least one other member does. Each one,
 * in creation order:
 * - successor: the longest-standing remaining member whose account is active
 *   (`users.status = 'active'`, so neither suspended nor deactivated, which
 *   includes the erasure grace period), earliest `joined_at`, ties broken by
 *   member `id`; when no member is active, the longest-standing member of any
 *   status. A persona whose last member was erased after the upfront
 *   selection (the erasure cascades into member rows, which are unlocked) is
 *   skipped and listed;
 * - under the `subprofile_create:<successor>` advisory lock that
 *   `SubprofilesService.create` takes, the slug is kept when the successor has
 *   no persona with it, and otherwise suffixed `-2`, `-3`, ... until free. The
 *   successor's slugs are read per persona, so two personas handed to the same
 *   successor never claim the same slug;
 * - for a Linked persona only, the vacated address `(old creator, old slug)`
 *   is upserted into `subprofile_address_history` so an old nested link
 *   forwards. An Unlinked persona never had a public nested address, and a
 *   history row for it would reveal who created it once it is linked later;
 * - `user_id`, `slug` and `updated_at` move to the successor;
 * - when the slug changes, a takedown that is still in force (hidden or
 *   removed) is copied to the new slug, merged into any row already there
 *   (the same statement as `copyTakedownToSlug` in
 *   `subprofile-creator-transfer.ts`).
 *
 * The persona rows are locked FOR UPDATE for the whole statement. It is
 * idempotent: a healthy database has no orphaned persona, so it changes
 * nothing. It reports its counts twice: a NOTICE for an operator at a psql
 * prompt, and a transaction-local setting,
 * {@link REPAIR_ORPHANED_PERSONA_CREATORS_TALLY_SETTING}, which a caller inside
 * the same transaction reads back as JSON.
 *
 * Every PL/pgSQL variable carries a `repair_` prefix so that none can collide
 * with a column of the tables it touches; a collision inside
 * `ON CONFLICT (...)` raises "column reference is ambiguous", and only on the
 * first run that actually reaches that statement.
 *
 * A concurrent account erasure can, rarely, deadlock with it (the erasure holds
 * the user row and waits on a locked persona while the history insert waits on
 * that user row). Postgres then aborts one side; rerunning finishes the repair.
 */
export const REPAIR_ORPHANED_PERSONA_CREATORS_TALLY_SETTING =
  'queerpulse.repair_orphaned_persona_creators_tally';

export const REPAIR_ORPHANED_PERSONA_CREATORS_SQL = `
DO $repair$
DECLARE
  repair_persona_ids uuid[];
  repair_persona_id uuid;
  repair_departed_creator_id uuid;
  repair_old_slug varchar;
  repair_link_visibility text;
  repair_successor_id uuid;
  repair_new_slug varchar;
  repair_suffix_number integer;
  repair_copied_count integer;
  repair_repaired_total integer := 0;
  repair_history_total integer := 0;
  repair_suffixed_total integer := 0;
  repair_copied_total integer := 0;
  repair_skipped_ids uuid[] := '{}';
BEGIN
  SELECT coalesce(array_agg("locked"."id" ORDER BY "locked"."created_at", "locked"."id"), '{}')
    INTO repair_persona_ids
    FROM (
      SELECT "persona"."id", "persona"."created_at"
        FROM "subprofiles" "persona"
       WHERE EXISTS (
               SELECT 1 FROM "subprofile_members" "member"
                WHERE "member"."subprofile_id" = "persona"."id"
             )
         AND NOT EXISTS (
               SELECT 1 FROM "subprofile_members" "creator_member"
                WHERE "creator_member"."subprofile_id" = "persona"."id"
                  AND "creator_member"."user_id" = "persona"."user_id"
             )
       FOR UPDATE OF "persona"
    ) "locked";

  FOREACH repair_persona_id IN ARRAY repair_persona_ids LOOP
    SELECT "persona"."user_id", "persona"."slug", "persona"."link_visibility"::text
      INTO repair_departed_creator_id, repair_old_slug, repair_link_visibility
      FROM "subprofiles" "persona"
     WHERE "persona"."id" = repair_persona_id;

    repair_successor_id := NULL;
    SELECT "member"."user_id"
      INTO repair_successor_id
      FROM "subprofile_members" "member"
      JOIN "users" "member_user" ON "member_user"."id" = "member"."user_id"
     WHERE "member"."subprofile_id" = repair_persona_id
     ORDER BY CASE WHEN "member_user"."status" = 'active' THEN 0 ELSE 1 END ASC,
              "member"."joined_at" ASC,
              "member"."id" ASC
     LIMIT 1;

    -- An account erasure cascaded away the last member: nobody to hand it to.
    IF repair_successor_id IS NULL THEN
      repair_skipped_ids := repair_skipped_ids || repair_persona_id;
      CONTINUE;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('subprofile_create:' || repair_successor_id::text));

    repair_new_slug := repair_old_slug;
    repair_suffix_number := 2;
    WHILE EXISTS (
      SELECT 1 FROM "subprofiles" "taken"
       WHERE "taken"."user_id" = repair_successor_id
         AND "taken"."slug" = repair_new_slug
    ) LOOP
      repair_new_slug := repair_old_slug || '-' || repair_suffix_number;
      repair_suffix_number := repair_suffix_number + 1;
    END LOOP;

    IF repair_link_visibility = 'linked' THEN
      INSERT INTO "subprofile_address_history" ("previous_user_id", "slug", "subprofile_id")
      VALUES (repair_departed_creator_id, repair_old_slug, repair_persona_id)
      ON CONFLICT ("previous_user_id", "slug")
      DO UPDATE SET "subprofile_id" = EXCLUDED."subprofile_id",
                    "moved_at" = now();
      repair_history_total := repair_history_total + 1;
    END IF;

    UPDATE "subprofiles"
       SET "user_id" = repair_successor_id,
           "slug" = repair_new_slug,
           "updated_at" = now()
     WHERE "id" = repair_persona_id;

    IF repair_new_slug <> repair_old_slug THEN
      repair_suffixed_total := repair_suffixed_total + 1;
      INSERT INTO "content_moderation"
             ("subject_type", "subject_id", "hidden_at", "removed_at",
              "moderated_by", "report_id", "reason_code", "note")
      SELECT "subject_type", repair_new_slug, "hidden_at", "removed_at",
             "moderated_by", "report_id", "reason_code", "note"
        FROM "content_moderation"
       WHERE "subject_type" = 'subprofile'
         AND "subject_id" = repair_old_slug
         AND ("hidden_at" IS NOT NULL OR "removed_at" IS NOT NULL)
      ON CONFLICT ("subject_type", "subject_id")
      DO UPDATE SET
        "hidden_at" = coalesce("content_moderation"."hidden_at", EXCLUDED."hidden_at"),
        "removed_at" = coalesce("content_moderation"."removed_at", EXCLUDED."removed_at"),
        "updated_at" = now();
      GET DIAGNOSTICS repair_copied_count = ROW_COUNT;
      repair_copied_total := repair_copied_total + repair_copied_count;
    END IF;

    repair_repaired_total := repair_repaired_total + 1;
  END LOOP;

  PERFORM set_config(
    '${REPAIR_ORPHANED_PERSONA_CREATORS_TALLY_SETTING}',
    json_build_object(
      'repairedPersonaCount', repair_repaired_total,
      'historyRowCount', repair_history_total,
      'suffixedSlugCount', repair_suffixed_total,
      'copiedModerationRowCount', repair_copied_total,
      'skippedPersonaIds', repair_skipped_ids
    )::text,
    true
  );
  RAISE NOTICE 'orphaned persona repair: repaired %, history rows %, slugs suffixed %, moderation rows copied %, skipped %',
    repair_repaired_total, repair_history_total, repair_suffixed_total, repair_copied_total, repair_skipped_ids;
END
$repair$;
`;

/** The counts one run of {@link REPAIR_ORPHANED_PERSONA_CREATORS_SQL} leaves
 * in {@link REPAIR_ORPHANED_PERSONA_CREATORS_TALLY_SETTING}. */
export interface RepairOrphanedPersonaCreatorsTally {
  repairedPersonaCount: number;
  historyRowCount: number;
  suffixedSlugCount: number;
  copiedModerationRowCount: number;
  skippedPersonaIds: string[];
}

/**
 * Read back the counts the repair left in its transaction-local setting.
 * Call it on the same query runner, inside the same transaction as the
 * repair; outside it the setting is gone.
 */
export async function readRepairOrphanedPersonaCreatorsTally(
  queryRunner: QueryRunner,
): Promise<RepairOrphanedPersonaCreatorsTally> {
  const rows = (await queryRunner.query(
    `SELECT current_setting($1, true) AS "tally"`,
    [REPAIR_ORPHANED_PERSONA_CREATORS_TALLY_SETTING],
  )) as { tally: string | null }[];
  const tallyText = rows[0]?.tally;
  if (!tallyText) {
    throw new Error(
      'The orphaned persona repair left no tally: read it inside the ' +
        'transaction that ran the repair.',
    );
  }
  return JSON.parse(tallyText) as RepairOrphanedPersonaCreatorsTally;
}
