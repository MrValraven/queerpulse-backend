import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes account deactivation and the deletion grace period actually hide the
 * member, by giving `users.status` a value for it.
 *
 * Before this, `POST /account/deactivate` wrote an `account_deactivation` row
 * that nothing outside the account module ever read, and
 * `POST /account/deletion-request` wrote a `deletion_request` row and revoked
 * sessions — while the UI promised "everything is hidden now". Nothing was
 * hidden. Adding `'deactivated'` to `users_status_enum` makes both promises
 * true through the `status = 'active'` predicates the codebase already applies
 * everywhere (directory search, feed, `MemberLookup`, connection/cohost/invite
 * targets, `ActiveMemberGuard`, the chat handshake).
 *
 * ---------------------------------------------------------------------------
 * Why `ALTER TYPE ... ADD VALUE` and not the rename-and-recreate dance
 * ---------------------------------------------------------------------------
 * TypeORM runs migrations inside a transaction — and by default
 * (`migrationsTransactionMode: 'all'`, which `src/data-source.ts` does not
 * override) it runs *every pending migration* in ONE transaction. That matters
 * because of a Postgres restriction people usually half-remember:
 *
 *   - Before PG 12, `ALTER TYPE ... ADD VALUE` could not run inside a
 *     transaction block at all.
 *   - From PG 12 on it can, but the newly added label **cannot be used** —
 *     written, compared, cast to — in that same transaction. Postgres raises
 *     `unsafe use of new value "..." of enum type`.
 *
 * This project targets **Postgres 16** (`docker-compose.yml` and the CI service
 * container in `.github/workflows/ci.yml` both pin `postgres:16`), so ADD VALUE
 * is transaction-legal here, and it is what the two prior enum-extending
 * migrations in this repo already do (`AddNotificationTypes1782693000000`,
 * `AddCommunityPostLikes1782800220000`).
 *
 * The rename-and-recreate alternative (rename the type, `CREATE TYPE` with the
 * full value list, `ALTER COLUMN ... TYPE ... USING ...::text::...`, drop the
 * old type) has no such restriction, but it takes an ACCESS EXCLUSIVE lock and
 * rewrites the whole `users` table, and it has to drop and re-add the column
 * default around the retype. That is a materially riskier operation on the
 * single most-read table in the schema, bought to solve a problem we do not
 * have. So: ADD VALUE.
 *
 * ⚠️ The constraint that comes with that choice, and the reason it is safe:
 * **nothing in this migration uses the string `'deactivated'`.** The two
 * backfills below copy `users.status` (only ever `pending|active|suspended` at
 * this point — no row can be `deactivated` yet, since the value did not exist a
 * statement ago), and there is no `WHERE status = 'deactivated'` anywhere. The
 * new value is first written at *runtime*, by `AccountService`, in a completely
 * different transaction. If a future migration in the same pending batch needs
 * to write `'deactivated'`, it must not — split it into its own run, or move it
 * behind `migrationsTransactionMode: 'each'`.
 *
 * `IF NOT EXISTS` on the ADD VALUE is the repo's existing idiom for enum
 * extension and is not the "guard the DDL to paper over a ledger mismatch"
 * anti-pattern CLAUDE.md warns about: `ADD VALUE` is genuinely idempotent
 * (there is no shape to drift), and Postgres offers no other way to express it.
 *
 * ---------------------------------------------------------------------------
 * `previous_status` on both ledgers
 * ---------------------------------------------------------------------------
 * Reactivation must restore the status the member *had*, not hardcode
 * `'active'`. `src/account/account.controller.ts` is deliberately JWT-only with
 * no `ActiveMemberGuard`, so a **suspended** member can reach both
 * `/account/deactivate` and `/account/deletion-request` today. Without these
 * columns, deactivate-then-sign-back-in (or request-deletion-then-cancel) would
 * be a one-click suspension launderer.
 *
 * Both columns are nullable because they post-date their tables, and both are
 * backfilled from `users.status` for the rows where restore could still be
 * reached: every `account_deactivation` row, and every `grace` deletion
 * request. Erased/cancelled requests are left NULL — there is nothing left to
 * restore.
 */
export class AddDeactivatedStatus1782800710000 implements MigrationInterface {
  name = 'AddDeactivatedStatus1782800710000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Transaction-safe on PG 12+ *because* no statement below uses the value.
    await queryRunner.query(
      `ALTER TYPE "users_status_enum" ADD VALUE IF NOT EXISTS 'deactivated'`,
    );

    // --- account_deactivation.previous_status ---------------------------------
    await queryRunner.query(
      `ALTER TABLE "account_deactivation" ADD COLUMN "previous_status" "users_status_enum"`,
    );
    // Backfill: these members were never actually hidden (that is the bug this
    // migration fixes), so their current `users.status` IS the status a future
    // reactivation should restore. Copying the column reads existing labels
    // only — it never mentions the new one.
    await queryRunner.query(`
      UPDATE "account_deactivation" AS d
         SET "previous_status" = u."status"
        FROM "users" AS u
       WHERE u."id" = d."user_id"
    `);

    // --- deletion_request.previous_status -------------------------------------
    await queryRunner.query(
      `ALTER TABLE "deletion_request" ADD COLUMN "previous_status" "users_status_enum"`,
    );
    // Only `grace` rows can still be cancelled, so only they need a restore
    // target. `deletion_request` has no FK to `users` on purpose (it outlives
    // the user row — see AddDeletionErasureSupport1782800700000), hence the
    // join can legitimately miss for already-erased accounts; those rows stay
    // NULL, which is correct.
    await queryRunner.query(`
      UPDATE "deletion_request" AS r
         SET "previous_status" = u."status"
        FROM "users" AS u
       WHERE u."id" = r."user_id"
         AND r."status" = 'grace'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ORDER MATTERS: restore first, THEN drop the columns the restore reads,
    // THEN rebuild the type.
    //
    // Postgres has no `DROP VALUE`, so removing the label means rebuilding the
    // type — and the `USING` cast at the bottom cannot map a `'deactivated'`
    // row onto a type that no longer has that label. Every such member has to
    // be given a real status back first, from their recorded `previous_status`
    // rather than a blanket `'active'`: mapping them all to active would
    // un-hide, and for a suspended member un-suspend, people mid-revert.
    //
    // Unlike `up()`, using the literal `'deactivated'` here is fine — by the
    // time a revert runs, the value was committed by an earlier transaction.
    await queryRunner.query(`
      UPDATE "users" AS u
         SET "status" = COALESCE(d."previous_status", 'active'::"users_status_enum")
        FROM "account_deactivation" AS d
       WHERE d."user_id" = u."id"
         AND u."status" = 'deactivated'
         AND d."reactivated_at" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "users" AS u
         SET "status" = COALESCE(r."previous_status", 'active'::"users_status_enum")
        FROM "deletion_request" AS r
       WHERE r."user_id" = u."id"
         AND u."status" = 'deactivated'
         AND r."status" = 'grace'
    `);
    // Anyone still `deactivated` has no ledger row to restore from (manual DB
    // surgery). Park them on `active` rather than letting the retype abort.
    await queryRunner.query(
      `UPDATE "users" SET "status" = 'active' WHERE "status" = 'deactivated'`,
    );

    await queryRunner.query(
      `ALTER TABLE "deletion_request" DROP COLUMN "previous_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_deactivation" DROP COLUMN "previous_status"`,
    );

    await queryRunner.query(
      `ALTER TYPE "users_status_enum" RENAME TO "users_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "users_status_enum" AS ENUM('pending', 'active', 'suspended')`,
    );
    // The column default references the old type and blocks the retype.
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE "users_status_enum" USING "status"::text::"users_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(`DROP TYPE "users_status_enum_old"`);
  }
}
