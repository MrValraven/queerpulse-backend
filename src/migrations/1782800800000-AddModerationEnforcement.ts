import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes `suspend` and `ban` actually suspend and ban.
 *
 * Until now `ModerationService.actOnReport` mapped a moderator's action to a
 * *report* status (`statusForAction` returns only `escalated` or `resolved`)
 * and wrote an audit row. It never loaded a `User`. `UserStatus.Suspended`
 * existed in the enum and was written by nothing, so every `suspend` and `ban`
 * ever issued closed the report and left the member fully active.
 *
 * Two changes:
 *
 * 1. **`users.suspended_until`** — when a suspension lapses. `NULL` while
 *    `status = 'suspended'` means a permanent ban; that is the only difference
 *    between `ban` and `suspend`, which is why no new `users_status_enum`
 *    value is added. Every existing `status = 'active'` predicate (directory,
 *    feed, member refs, `ActiveMemberGuard`, the chat handshake) therefore
 *    keeps working untouched, and `JwtStrategy`'s per-request status read makes
 *    enforcement immediate.
 *
 *    Expiry is lazy with write-through in `JwtStrategy` rather than a cron:
 *    the suspended member's own next request restores them and writes the row
 *    back, so directory and feed see them again too.
 *
 * 2. **`mod_audit_logs.report_id` becomes nullable** — so lifting a suspension
 *    (`PATCH /mod/users/:userId/suspension`) can be recorded even when it is
 *    not a response to a specific report. Inventing a placeholder report id to
 *    satisfy a NOT NULL would put a lie in the immutable trail.
 *
 *    Note the consequence: a lift with no `reportId` does not appear in any
 *    per-report `GET /mod/reports/audit` trail, because that endpoint filters
 *    by `reportId`. There is no global audit feed yet. The lift DTO therefore
 *    accepts an optional `reportId` so a moderator acting on a specific report
 *    can keep the two linked.
 *
 * Applying this changes no existing behaviour: the column defaults to NULL on
 * every current row (all of which are `active`), and relaxing a NOT NULL
 * cannot invalidate data already stored.
 */
export class AddModerationEnforcement1782800800000 implements MigrationInterface {
  name = 'AddModerationEnforcement1782800800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "suspended_until" TIMESTAMP WITH TIME ZONE`,
    );

    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" ALTER COLUMN "report_id" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rows written by a suspension lift have no report_id and cannot be
    // restored to a NOT NULL column. Delete them rather than fail the revert or
    // fabricate an id — they are the only rows this migration made possible.
    await queryRunner.query(
      `DELETE FROM "mod_audit_logs" WHERE "report_id" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" ALTER COLUMN "report_id" SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "suspended_until"`,
    );
  }
}
