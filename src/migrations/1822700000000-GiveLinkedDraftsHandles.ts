// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import { RESERVED_HANDLES } from '../common/handles';

/**
 * A linked persona now stores its `/p/<handle>` from the moment it exists,
 * draft or published. `1822100000000-GiveLinkedPersonasHandles` backfilled
 * published linked personas only, because back then a linked draft got its
 * handle at publish. This fills the drafts that rule left behind, so the
 * editor and the preview can show a draft the address it will publish under.
 *
 * Drafts never claim. The `handles` registry holds a row for a persona only
 * while it is published, so this writes `subprofiles.handle` and nothing else:
 * no `handles` insert, and no `handle_history` cleanup (that cleanup belongs to
 * the claim at publish time, which `HandlesService.claim` still performs).
 *
 * Backfill: each linked, NOT published, not-removed persona with no handle gets
 * `<creatorSlug>-<personaSlug>` under the same rules as
 * `src/subprofiles/persona-handle.ts` and the published backfill (30-char cut,
 * persona part keeps at least 3 chars, `-2`..`-99` on a clash with the
 * registry, a live cooldown or the reserved list). A candidate is also
 * rejected when ANY other subprofile row stores it as its `handle`, whatever
 * that row's status. The unique index on `subprofiles.handle` binds published
 * rows only, so two drafts could legally share a name, but `/p/<handle>` has
 * to resolve one draft unambiguously, and a draft sharing a published
 * persona's name would never be reachable at all. The loop runs oldest first
 * and sees its own earlier writes, so two drafts backfilled here never land on
 * the same name either. A persona whose creator has no profile slug, or that
 * exhausts the suffixes, is skipped and counted; it keeps the null handle
 * every linked draft carried before this rule.
 * Idempotent: rows that already store a handle are left alone.
 */
export class GiveLinkedDraftsHandles1822700000000 implements MigrationInterface {
  name = 'GiveLinkedDraftsHandles1822700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Handles are [a-z0-9-] only, so they are safe to inline as literals.
    const reservedArray = `ARRAY[${RESERVED_HANDLES.map((name) => `'${name}'`).join(',')}]::text[]`;
    await queryRunner.query(`
      DO $$
      DECLARE
        persona RECORD;
        reserved text[] := ${reservedArray};
        tail text;
        budget int;
        persona_part text;
        creator_part text;
        candidate text;
        assigned_count int := 0;
        skipped_count int := 0;
      BEGIN
        FOR persona IN
          SELECT subprofile.id,
                 trim(both '-' from lower(subprofile.slug)) AS persona_slug,
                 trim(both '-' from lower(profile.slug)) AS creator_slug
          FROM "subprofiles" subprofile
          LEFT JOIN "profiles" profile ON profile.user_id = subprofile.user_id
          WHERE subprofile.link_visibility = 'linked'
            AND subprofile.status <> 'published'
            AND subprofile.removed_at IS NULL
            AND subprofile.handle IS NULL
          ORDER BY subprofile.created_at, subprofile.id
        LOOP
          IF persona.creator_slug IS NULL OR persona.creator_slug = '' THEN
            skipped_count := skipped_count + 1;
            CONTINUE;
          END IF;
          candidate := NULL;
          FOR suffix IN 1..99 LOOP
            tail := CASE WHEN suffix > 1 THEN '-' || suffix ELSE '' END;
            budget := 30 - length(tail);
            persona_part := trim(both '-' from left(persona.persona_slug,
              GREATEST(3, budget - length(persona.creator_slug) - 1)));
            creator_part := trim(both '-' from left(persona.creator_slug,
              budget - length(persona_part) - 1));
            candidate := creator_part || '-' || persona_part || tail;
            EXIT WHEN candidate ~ '^[a-z0-9][a-z0-9-]{2,29}$'
              AND NOT (candidate = ANY(reserved))
              AND NOT EXISTS (SELECT 1 FROM "handles" WHERE name = candidate)
              AND NOT EXISTS (
                SELECT 1 FROM "handle_history"
                WHERE name = candidate AND reclaimable_at > now()
              )
              AND NOT EXISTS (
                SELECT 1 FROM "subprofiles"
                WHERE handle = candidate AND id <> persona.id
              );
            candidate := NULL;
          END LOOP;
          IF candidate IS NULL THEN
            skipped_count := skipped_count + 1;
            CONTINUE;
          END IF;
          -- Drafts never claim: no "handles" row and no "handle_history"
          -- cleanup here. Publishing claims the name through HandlesService.
          UPDATE "subprofiles" SET handle = candidate WHERE id = persona.id;
          assigned_count := assigned_count + 1;
        END LOOP;
        RAISE NOTICE 'GiveLinkedDraftsHandles: assigned %, skipped %',
          assigned_count, skipped_count;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only unpublished linked rows are touched, so a published persona keeps
    // its handle whatever the registry says. A draft whose handle is recorded
    // for it in the registry is left alone too; the backfill above never
    // writes one, so such a row did not come from this migration. Registry
    // names are stored normalized (trimmed, lowercased), so the match
    // normalizes the handle.
    await queryRunner.query(`
      UPDATE "subprofiles" subprofile SET handle = NULL
      WHERE subprofile.link_visibility = 'linked'
        AND subprofile.status <> 'published'
        AND subprofile.handle IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "handles" registry
          WHERE registry.subprofile_id = subprofile.id
            AND registry.name = lower(trim(subprofile.handle))
        )
    `);
  }
}
