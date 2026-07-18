import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deletes the `'pending'` member state. After
 * `PublicJoinRequests1782800730000` a stranger is represented by a
 * `join_requests` row, not by a half-built `users` row, so the intended model
 * finally holds literally: you are either not a member, or an active one.
 *
 * `'pending'` was already vestigial before this. `AuthService.validateOrCreateGoogleUser`
 * rejects an uninvited new Google account and creates an invited one as
 * `'active'`, so nothing in the running system ever wrote the label — which in
 * turn made three code paths permanently dead (`UsersService.promoteToActive`,
 * the vouch-threshold promotion in `vouch.service.ts`, and the
 * promote-on-accept branch of `invites.service.ts`). All three go away with the
 * label; vouches survive purely as a trust signal and stop gating membership.
 *
 * ---------------------------------------------------------------------------
 * DATA DECISION: surviving `pending` users become `'suspended'`, not `'active'`
 * ---------------------------------------------------------------------------
 * The retype below cannot map a row whose label no longer exists, so every
 * `pending` row must be given a real value FIRST or `ALTER COLUMN ... TYPE`
 * aborts.
 *
 * `'active'` is the tempting choice and it is the wrong one. A `pending` row,
 * by construction, is an account that authenticated with Google but was NEVER
 * approved by anyone — that is the entire meaning of the state. Mapping it to
 * `'active'` would silently grant full membership (directory listing, feed,
 * messaging, invite minting) to unreviewed accounts, which is precisely the
 * admission-control bypass this whole change set exists to close. `'suspended'`
 * is the correct landing spot: it is the one remaining non-membership value, it
 * is already excluded by every `status = 'active'` predicate in the codebase,
 * and it is *reversible* — an admin who recognises the person can flip them to
 * active, whereas an accidental mass-activation cannot be un-rung.
 *
 * `'deactivated'` was rejected as the alternative: it means "a member paused
 * themselves", it is undone automatically by simply signing back in with Google
 * (`AuthService.reactivateIfDeactivated`), and it restores to
 * `previous_status` — so it would auto-promote these accounts on their next
 * login. That is `'active'` with extra steps.
 *
 * In practice the set is expected to be EMPTY outside a developer machine: the
 * only writer of `'pending'` was `src/database/seed.ts` (updated in this change
 * set to stop creating one).
 *
 * The same `UPDATE` is applied to `account_deactivation.previous_status` and
 * `deletion_request.previous_status` — both are `users_status_enum` columns
 * (added by `AddDeactivatedStatus1782800710000`) and both can legitimately hold
 * `'pending'` for a member who deactivated while pending. They get `'suspended'`
 * for the same reason: reactivation restores `previous_status` verbatim, so
 * leaving a value that means "unreviewed" must not resolve to membership.
 *
 * ---------------------------------------------------------------------------
 * Why rename-and-recreate, and the two traps in it
 * ---------------------------------------------------------------------------
 * Postgres has no `ALTER TYPE ... DROP VALUE`, so REMOVING a label always means
 * rebuilding the type. This is the same dance `AddDeactivatedStatus1782800710000`
 * performs in its `down()`, and it is copied from there.
 *
 * Trap 1 — the column default. `users.status` defaults to `'pending'`, and a
 * default referencing the old type blocks the retype. It is dropped before and
 * re-established after, and it comes back as **`'active'`**, not `'pending'`:
 * the entity default in `src/users/entities/user.entity.ts` changes in lockstep,
 * and without this every INSERT that omits `status` would fail on a label that
 * no longer exists.
 *
 * Trap 2 — `DROP TYPE` has THREE dependents, not one. `AddDeactivatedStatus`'s
 * `down()` only had to retype `users.status` because it dropped both
 * `previous_status` columns first. Those columns are still here, so all three
 * are retyped below; miss either one and `DROP TYPE "users_status_enum_old"`
 * fails with a dependency error.
 *
 * Note this migration deliberately does NOT use `ALTER TYPE ... ADD VALUE`
 * anywhere — including in `down()`, which rebuilds the four-label type with
 * `CREATE TYPE` instead. That sidesteps the PG12+ restriction documented at
 * length in `AddDeactivatedStatus1782800710000`: a label added with ADD VALUE
 * cannot be *used* in the same transaction, and TypeORM runs the whole pending
 * batch in one. `down()` has to write `'pending'` immediately (it is the
 * restored column default), so ADD VALUE would fail there.
 */
export class RemovePendingStatus1782800740000 implements MigrationInterface {
  name = 'RemovePendingStatus1782800740000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ORDER MATTERS: drain the label out of every column that can hold it
    // BEFORE the type is rebuilt without it. See the DATA DECISION block.
    await queryRunner.query(
      `UPDATE "users" SET "status" = 'suspended' WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `UPDATE "account_deactivation" SET "previous_status" = 'suspended' WHERE "previous_status" = 'pending'`,
    );
    await queryRunner.query(
      `UPDATE "deletion_request" SET "previous_status" = 'suspended' WHERE "previous_status" = 'pending'`,
    );

    // Trap 1: the default references the old type.
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT`,
    );

    await queryRunner.query(
      `ALTER TYPE "users_status_enum" RENAME TO "users_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "users_status_enum" AS ENUM('active', 'suspended', 'deactivated')`,
    );

    // Trap 2: all three dependent columns, or DROP TYPE below fails.
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE "users_status_enum" USING "status"::text::"users_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_deactivation" ALTER COLUMN "previous_status" TYPE "users_status_enum" USING "previous_status"::text::"users_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "deletion_request" ALTER COLUMN "previous_status" TYPE "users_status_enum" USING "previous_status"::text::"users_status_enum"`,
    );

    // New default: membership is the only state a `users` row can be born into.
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'active'`,
    );
    await queryRunner.query(`DROP TYPE "users_status_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-widening the type is pure DDL — no row holds a label that is about to
    // disappear, because the four-value type is a superset of the three-value
    // one. `CREATE TYPE` (not ADD VALUE) so the restored `'pending'` default
    // below is writable in this same transaction.
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TYPE "users_status_enum" RENAME TO "users_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "users_status_enum" AS ENUM('pending', 'active', 'suspended', 'deactivated')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE "users_status_enum" USING "status"::text::"users_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_deactivation" ALTER COLUMN "previous_status" TYPE "users_status_enum" USING "previous_status"::text::"users_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "deletion_request" ALTER COLUMN "previous_status" TYPE "users_status_enum" USING "previous_status"::text::"users_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(`DROP TYPE "users_status_enum_old"`);

    // NOT REVERSIBLE: the members mapped to `'suspended'` by up() are
    // indistinguishable from members who were genuinely suspended, so they are
    // left as-is rather than being blanket-restored to `'pending'` (which would
    // un-suspend real suspensions). Re-running up() afterwards is a no-op for
    // them, which is the safe direction.
  }
}
