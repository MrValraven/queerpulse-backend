import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Completes the `handles` backfill started by `AddHandles1782800660000`, which
 * only inserted slugs matching HANDLE_RE and left the rest unrepresented.
 *
 * Why an unrepresented profile is dangerous. A slug that fails HANDLE_RE is not
 * directly claimable (`handleFormatError` rejects it before any DB hit), so the
 * gap is not exploitable on its own. The danger is `HandlesService.release`,
 * which deletes by normalized name. Given two legacy profiles whose slugs fold
 * together — `John` and `john` — the backfill registers `john` to whichever won,
 * and the loser has no row. When the loser later renames, `rename` releases
 * `normalizeHandle('John')` = `john` and deletes the WINNER's registry row. The
 * winner keeps a live `/members/john` while `john` silently returns to the pool,
 * and the next caller can claim `/p/john`. (The companion fix scopes `release`
 * to its owner so it can never delete another owner's row; this migration closes
 * the other half by making the registry complete.)
 *
 * Strategy: reserve EVERY profile slug, including out-of-format ones. Reserving
 * a name nobody can claim is harmless — the row simply occupies the namespace —
 * whereas leaving it absent is what breaks the invariant that every live
 * `/members/<slug>` owns its name.
 *
 * Case-fold collisions cannot be resolved automatically: two distinct profiles
 * genuinely want one name, and picking a winner here would silently strip a
 * member's username. Those raise and block the deploy for a human to resolve.
 */
export class BackfillHandleStragglers1782800670000 implements MigrationInterface {
  name = 'BackfillHandleStragglers1782800670000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Reserve every slug not already registered. DISTINCT ON keeps exactly one
    // row per folded name, oldest profile first, so this INSERT is deterministic
    // rather than dependent on scan order. Collision losers stay unregistered
    // and are caught by the verification below.
    await queryRunner.query(`
      INSERT INTO "handles" ("name", "owner_kind", "user_id")
      SELECT DISTINCT ON (lower(p."slug"))
             lower(p."slug"), 'profile', p."user_id"
      FROM "profiles" p
      WHERE NOT EXISTS (
        SELECT 1 FROM "handles" h WHERE h."name" = lower(p."slug")
      )
      ORDER BY lower(p."slug"), p."created_at" ASC
      ON CONFLICT ("name") DO NOTHING
    `);

    // Every profile must now own the registry row for its own slug. Anything
    // left is a case-fold collision between two real members.
    const orphans = (await queryRunner.query(`
        SELECT p."slug", p."user_id"
        FROM "profiles" p
        WHERE NOT EXISTS (
          SELECT 1 FROM "handles" h
          WHERE h."name" = lower(p."slug") AND h."user_id" = p."user_id"
        )
        ORDER BY p."slug"
      `)) as { slug: string; user_id: string }[];

    if (orphans.length > 0) {
      const detail = orphans
        .map((o) => `${o.slug} (user ${o.user_id})`)
        .join(', ');
      throw new Error(
        `Cannot complete the handles backfill: ${orphans.length} profile slug(s) ` +
          `collide case-insensitively with a handle owned by someone else, so they ` +
          `cannot be reserved automatically: ${detail}. Resolve by renaming the ` +
          `affected profiles' slugs to distinct values, then re-run this migration.`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove only the profile reservations this migration could have added:
    // those whose name is NOT a valid handle (the in-format ones were already
    // inserted by AddHandles and are not ours to delete).
    await queryRunner.query(`
      DELETE FROM "handles"
      WHERE "owner_kind" = 'profile'
        AND "name" !~ '^[a-z0-9][a-z0-9-]{2,29}$'
    `);
  }
}
