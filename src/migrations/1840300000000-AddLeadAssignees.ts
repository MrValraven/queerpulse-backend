// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Leads assignees: the `lead_assignees` table holds one row per lead and staff
 * member in charge of it, and `lead_entries.subject_user_id` names the staff
 * member an assignee entry is about. Three new entry kinds (`assignee_added`,
 * `assignee_removed`, `assignee_access_ended`) and the `lead_assigned`
 * notification label complete the feature.
 *
 * The default migration transaction stays. Two precedents, the member event
 * invites and the group consent invites migrations, also add enum labels next
 * to table changes: on Postgres 12+ `ALTER TYPE ... ADD VALUE` may run inside
 * the wrapping transaction as long as no statement in that transaction uses the
 * new label, and nothing here does. The label append runs last.
 *
 * `lead_entries.kind` widens to `varchar(32)` because `assignee_access_ended`
 * is 21 characters; widening a `varchar` is a catalog change with no table
 * rewrite.
 *
 * Indexes and the keys they back:
 * - `IDX_lead_assignees_user_id` serves "Assigned to me", the nav badge, the
 *   access-loss delete and the `ON DELETE CASCADE` from `users`. The primary
 *   key `(lead_id, user_id)` serves every per-lead read.
 * - `IDX_lead_assignees_assigned_by_id` backs `FK_lead_assignees_assigned_by`
 *   (`ON DELETE SET NULL`).
 * - `IDX_lead_entries_subject_user_id` backs `FK_lead_entries_subject_user`
 *   (`ON DELETE SET NULL`), the same way `IDX_lead_entries_author_id` backs the
 *   author key.
 *
 * Every new table and column is new or empty, so each index builds inside the
 * migration transaction.
 */
export class AddLeadAssignees1840300000000 implements MigrationInterface {
  name = 'AddLeadAssignees1840300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lead_entries" ALTER COLUMN "kind" TYPE character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" DROP CONSTRAINT "CHK_lead_entries_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" ADD CONSTRAINT "CHK_lead_entries_kind" CHECK ("kind" IN ('note', 'stage_changed', 'persona_linked', 'persona_unlinked', 'created', 'assignee_added', 'assignee_removed', 'assignee_access_ended'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" ADD "subject_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" ADD CONSTRAINT "CHK_lead_entries_subject" CHECK ("subject_user_id" IS NULL OR "kind" IN ('assignee_added', 'assignee_removed', 'assignee_access_ended'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" ADD CONSTRAINT "FK_lead_entries_subject_user" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lead_entries_subject_user_id" ON "lead_entries" ("subject_user_id") WHERE "subject_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "lead_assignees" (
        "lead_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "assigned_by_id" uuid,
        "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lead_assignees" PRIMARY KEY ("lead_id", "user_id"),
        CONSTRAINT "FK_lead_assignees_lead" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_lead_assignees_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_lead_assignees_assigned_by" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lead_assignees_user_id" ON "lead_assignees" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lead_assignees_assigned_by_id" ON "lead_assignees" ("assigned_by_id") WHERE "assigned_by_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'lead_assigned'`,
    );
  }

  /**
   * The `lead_assigned` label stays in `notifications_type_enum` after this
   * runs: Postgres cannot drop an enum value, the label is inert once no row
   * carries it, and `IF NOT EXISTS` keeps a later `up()` re-runnable.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type" = 'lead_assigned'`,
    );
    await queryRunner.query(`DROP TABLE "lead_assignees"`);
    await queryRunner.query(
      `DELETE FROM "lead_entries" WHERE "kind" IN ('assignee_added', 'assignee_removed', 'assignee_access_ended')`,
    );
    await queryRunner.query(`DROP INDEX "IDX_lead_entries_subject_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "lead_entries" DROP CONSTRAINT "FK_lead_entries_subject_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" DROP CONSTRAINT "CHK_lead_entries_subject"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" DROP COLUMN "subject_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" DROP CONSTRAINT "CHK_lead_entries_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" ADD CONSTRAINT "CHK_lead_entries_kind" CHECK ("kind" IN ('note', 'stage_changed', 'persona_linked', 'persona_unlinked', 'created'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "lead_entries" ALTER COLUMN "kind" TYPE character varying(20)`,
    );
  }
}
