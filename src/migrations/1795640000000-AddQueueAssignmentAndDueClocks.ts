// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * OPS-04 — assignment and a waiting-time clock for every staff queue, not just
 * moderation.
 *
 * WHY. Exactly one queue on this platform had either concept. `reports` has
 * `assigned_moderator_id`/`assigned_at` and `sla_due_at`, and the moderation
 * console is built on them: claim a row, release it, filter to "Assigned to
 * me", see an overdue badge. Invite requests, verification requests, intakes
 * and partner applications had neither column. With two people on the rota
 * that means every queue except moderation is double-worked or not worked, and
 * nothing anywhere escalates on age: a partner application could sit for six
 * weeks with nothing going red.
 *
 * WHAT. The same three columns on four tables, from the shared
 * `QueueAssignmentColumns` base entity (`src/common/queue-assignment.columns.ts`):
 *
 *   assigned_staff_id  uuid          NULL  FK -> users(id) ON DELETE SET NULL
 *   assigned_at        timestamptz   NULL
 *   due_at             timestamptz(3) NULL
 *
 * `ON DELETE SET NULL`, never CASCADE and never RESTRICT: when a staff member
 * exercises their right to erasure, the rows they were holding must revert to
 * unassigned so the next person picks them up. Blocking the erasure sweep on a
 * claimed queue row, or deleting an applicant's request because a reviewer left,
 * are both wrong answers. This matches `reports.assigned_moderator_id` and
 * `intake_submissions.reviewed_by_id`.
 *
 * `due_at` is `timestamptz(3)`, matching `reports.sla_due_at`: Postgres stores
 * microseconds by default, a JS `Date` carries milliseconds, and any future
 * keyset paging over this column would re-serve its boundary row if the stored
 * value had a sub-millisecond tail the cursor could not express. Narrowing now
 * costs nothing; narrowing later means rewriting every row.
 *
 * INDEXES — only where something reads them. `join_requests` and
 * `verification_requests` both gain an "Assigned to me" filter in this change
 * (`JoinRequestsService.list`, `VerificationService.listRequestsForAdmin`), so
 * both get a plain b-tree on `assigned_staff_id`. `intake_submissions` and
 * `partners` get NO index: their consoles have no assignee filter, and the
 * claim/release write addresses a row by primary key. No index is added on
 * `due_at` anywhere, because nothing sorts or filters on it server-side — the
 * overdue treatment is computed per row on a page already fetched, exactly as
 * the moderation queue's badge is.
 *
 * BACKFILL. Every window is a pure function of the row's own creation time
 * (see each queue's `*-sla.ts`), so an existing row's due date is derivable
 * rather than invented:
 *
 *   join_requests           created_at + 3 days
 *   verification_requests    updated_at + 3 days for an appeal,
 *                            created_at + 5 days otherwise
 *   intake_submissions       created_at + 3 / 7 / 14 days, by kind
 *   partners                 created_at + 14 days
 *
 * AN APPEAL DATES FROM THE APPEAL, NOT FROM THE ORIGINAL REQUEST. The live
 * path (`VerificationService.appealRequest`) restarts the clock at the moment
 * of the appeal, because an appeal re-opens a request that was already decided
 * and its old due date is spent. Deriving a backfilled appeal's due date from
 * `created_at` would say something different from what every appeal written
 * after this migration says, and it would be brutally wrong in the ordinary
 * case: a request submitted six months ago and appealed yesterday would be
 * stamped ~6 months overdue the instant this ran, lighting the queue red on a
 * deadline that never existed.
 *
 * `verification_requests` has no `appealed_at`. It has `updated_at`, an
 * `@UpdateDateColumn` whose last write for a row currently sitting in
 * `appealing` IS that appeal (the appeal sets `is_appeal`, `status` and
 * `due_at` in one `save`, and nothing else touches an appealing row until a
 * reviewer decides it, at which point it leaves the open set this backfill
 * covers). It is a proxy rather than the real thing, and it can only be wrong
 * in the harmless direction: a later unrelated write would push the due date
 * further out, never into a fabricated past.
 *
 * ONLY OPEN ROWS ARE BACKFILLED. A request that was decided last March has no
 * clock left to run, and stamping one would light up historical rows as
 * "overdue" on a queue nobody can act on. Decided rows keep NULL, and NULL is
 * defined everywhere as "no clock" — never as "overdue". Every read path
 * (`isQueueRowOverdue` on the frontend, and each DTO mapper here) treats a null
 * `due_at` as nothing to say.
 *
 * These numbers are duplicated as SQL intervals below rather than imported: a
 * migration is a historical record of what was run and must not change meaning
 * when a constant is edited later. The `*-sla.ts` files own the policy from
 * here on; this backfill is a one-time snapshot of it.
 *
 * TRANSACTIONAL. Plain DDL plus one UPDATE per table — no enum `ADD VALUE`, no
 * `CREATE INDEX CONCURRENTLY`, so this runs in a single transaction like the
 * rest of the additive column migrations here.
 */
export class AddQueueAssignmentAndDueClocks1795640000000 implements MigrationInterface {
  name = 'AddQueueAssignmentAndDueClocks1795640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'join_requests',
      'verification_requests',
      'intake_submissions',
      'partners',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}"
           ADD COLUMN "assigned_staff_id" uuid,
           ADD COLUMN "assigned_at" TIMESTAMP WITH TIME ZONE,
           ADD COLUMN "due_at" TIMESTAMP(3) WITH TIME ZONE`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}"
           ADD CONSTRAINT "FK_${table}_assigned_staff_id"
           FOREIGN KEY ("assigned_staff_id") REFERENCES "users"("id")
           ON DELETE SET NULL`,
      );
    }

    // Only the two queues that filter on the column (see the note above).
    await queryRunner.query(
      `CREATE INDEX "IDX_join_requests_assigned_staff_id"
         ON "join_requests" ("assigned_staff_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_verification_requests_assigned_staff_id"
         ON "verification_requests" ("assigned_staff_id")`,
    );

    // --- backfill, open rows only ---

    // `pending` and `waitlisted` are both states a reviewer can still act on
    // (`JoinRequestsService.review` accepts either); approved/declined are
    // terminal.
    await queryRunner.query(
      `UPDATE "join_requests"
          SET "due_at" = "created_at" + INTERVAL '3 days'
        WHERE "status" IN ('pending', 'waitlisted')`,
    );

    // `OPEN_REQUEST_STATUSES` in `verification.service.ts`. An appeal is the
    // member's SECOND wait on the same question, so it gets the shorter
    // window AND a clock that starts at the appeal. See the docblock: the
    // appeal's own write is `updated_at`, and dating it from `created_at`
    // instead would stamp a months-old request as long overdue on a deadline
    // that never existed.
    await queryRunner.query(
      `UPDATE "verification_requests"
          SET "due_at" = CASE
                WHEN "is_appeal" THEN "updated_at" + INTERVAL '3 days'
                ELSE "created_at" + INTERVAL '5 days'
              END
        WHERE "status" IN ('pending', 'in_review', 'appealing')`,
    );

    // `new` is untouched; `reviewing` is the governance worklist's in-progress
    // state. `reviewed`/`resolved`/`dismissed` are all done.
    await queryRunner.query(
      `UPDATE "intake_submissions"
          SET "due_at" = "created_at"
            + CASE
                WHEN "kind" = 'governance_concern' THEN INTERVAL '3 days'
                WHEN "kind" IN ('sober_host', 'panel_signup')
                  THEN INTERVAL '7 days'
                ELSE INTERVAL '14 days'
              END
        WHERE "status" IN ('new', 'reviewing')`,
    );

    // A pending partner row IS the open application; approved/rejected are
    // terminal.
    await queryRunner.query(
      `UPDATE "partners"
          SET "due_at" = "created_at" + INTERVAL '14 days'
        WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A complete undo: the indexes and constraints go with the columns they
    // were built on, and the backfilled values existed nowhere before this
    // migration wrote them, so dropping the columns loses nothing that was not
    // derivable from `created_at` in the first place.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_verification_requests_assigned_staff_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_join_requests_assigned_staff_id"`,
    );

    for (const table of [
      'partners',
      'intake_submissions',
      'verification_requests',
      'join_requests',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}"
           DROP CONSTRAINT "FK_${table}_assigned_staff_id"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}"
           DROP COLUMN "due_at",
           DROP COLUMN "assigned_at",
           DROP COLUMN "assigned_staff_id"`,
      );
    }
  }
}
