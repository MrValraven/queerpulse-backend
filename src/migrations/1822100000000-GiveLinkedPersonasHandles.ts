// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import { RESERVED_HANDLES } from '../common/handles';

/**
 * Every persona gets a `/p/<handle>` address. Linked personas used to live at
 * `/members/<owner>/<slug>` with no handle; from now on a published persona
 * always holds a `handles` registry row, linked or not.
 *
 * 1. `handle_history.is_forwarding`: a release written by a linked/unlinked
 *    switch must never answer `PERSONA_MOVED`, or the forwarding would tie a
 *    pseudonymous address to its owner. Existing rows keep forwarding, except
 *    a history row already sitting under a persona that is linked NOW: that
 *    row is the pseudonymous handle released when the persona last switched
 *    unlinked to linked, and once step 2 below hands the persona a `/p/`
 *    handle, forwarding that old row would out the same owner.
 * 2. Backfill: each published, not-removed, linked persona with no handle gets
 *    `<creatorSlug>-<personaSlug>` under the same rules as
 *    `src/subprofiles/persona-handle.ts` (30-char cut, persona part keeps at
 *    least 3 chars, `-2`..`-99` on a clash with the registry, a live cooldown
 *    or the reserved list). A candidate is also rejected when a DIFFERENT
 *    published persona already holds it as its own `subprofiles.handle`
 *    (spec 4.8): that row predates the `handles` registry and has no row
 *    there yet, so skipping only the `handles`/`handle_history` checks would
 *    let the backfill's own `UPDATE` collide with it and abort the whole
 *    migration on `UQ_subprofiles_handle`. A persona whose creator has no
 *    profile slug, or that exhausts the suffixes, is skipped and counted; it
 *    keeps resolving at its nested address. A published linked persona that
 *    stores a handle with no matching `handles` row (older code let PATCH write
 *    an unchecked handle to a linked persona) has that handle cleared first,
 *    so the backfill derives a registered one in its place. Idempotent: rows
 *    whose handle is registered to them are left alone.
 */
export class GiveLinkedPersonasHandles1822100000000 implements MigrationInterface {
  name = 'GiveLinkedPersonasHandles1822100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "handle_history" ADD COLUMN "is_forwarding" boolean NOT NULL DEFAULT true`,
    );
    // A history row already sitting under a persona that is linked NOW is the
    // pseudonymous handle released the last time that persona switched
    // unlinked to linked. The backfill below is about to give the persona a
    // `/p/` handle, so forwarding that old row would connect the anonymous
    // address to the owner it now names. Mark it non-forwarding up front,
    // before the backfill runs.
    await queryRunner.query(`
      UPDATE "handle_history" SET is_forwarding = false
      WHERE previous_owner_kind = 'subprofile'
        AND previous_owner_subprofile_id IN (
          SELECT id FROM "subprofiles" WHERE link_visibility = 'linked'
        )
    `);
    // Handles are [a-z0-9-] only, so they are safe to inline as literals.
    const reservedArray = `ARRAY[${RESERVED_HANDLES.map((name) => `'${name}'`).join(',')}]::text[]`;
    // A published linked persona holding a handle the registry never recorded
    // for it: older code let PATCH write an unchecked handle to a linked
    // persona. `/p/` now serves that handle, so clear it and let the loop
    // below derive and register a fresh one. Registry names are stored
    // normalized (trimmed, lowercased), so the match normalizes the handle.
    await queryRunner.query(`
      UPDATE "subprofiles" subprofile SET handle = NULL
      WHERE subprofile.link_visibility = 'linked'
        AND subprofile.status = 'published'
        AND subprofile.handle IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "handles" registry
          WHERE registry.subprofile_id = subprofile.id
            AND registry.name = lower(trim(subprofile.handle))
        )
    `);
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
            AND subprofile.status = 'published'
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
                WHERE handle = candidate AND status = 'published'
              );
            candidate := NULL;
          END LOOP;
          IF candidate IS NULL THEN
            skipped_count := skipped_count + 1;
            CONTINUE;
          END IF;
          UPDATE "subprofiles" SET handle = candidate WHERE id = persona.id;
          INSERT INTO "handles" (name, owner_kind, subprofile_id)
            VALUES (candidate, 'subprofile', persona.id);
          -- Mirrors HandlesService.claim, which clears a lapsed reservation
          -- for the name it claims: a candidate can only reach here past the
          -- reclaimable_at check above, so any row left is already lapsed.
          DELETE FROM "handle_history" WHERE name = candidate;
          assigned_count := assigned_count + 1;
        END LOOP;
        RAISE NOTICE 'GiveLinkedPersonasHandles: assigned %, skipped %',
          assigned_count, skipped_count;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "handles" registry
      USING "subprofiles" subprofile
      WHERE registry.subprofile_id = subprofile.id
        AND subprofile.link_visibility = 'linked'
    `);
    await queryRunner.query(
      `UPDATE "subprofiles" SET handle = NULL WHERE link_visibility = 'linked'`,
    );
    await queryRunner.query(
      `ALTER TABLE "handle_history" DROP COLUMN "is_forwarding"`,
    );
  }
}
