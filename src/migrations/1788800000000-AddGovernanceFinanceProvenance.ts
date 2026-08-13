import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the admin governance Finances tab honest and editable.
 *
 * Until now every figure on `/admin/governance` came from the quarterly seed
 * and was read-only — there was no way to tell a real number from a
 * placeholder, nor to correct one. This migration adds:
 *
 * 1. A shared `governance_finance_report_source_enum` (`seeded`/`manual`/
 *    `computed`) and five per-metric source columns on
 *    `governance_finance_report`, each defaulting to `seeded` so existing rows
 *    are labelled truthfully the moment this runs. `surplus` gets no column —
 *    it is always `income_total - expense_total`, so its provenance is a
 *    constant `computed` the DTO reports, never stored.
 * 2. `metrics_edited_by` / `metrics_edited_at` on the report, the "last edited
 *    by X on <date>" behind each badge. `metrics_edited_by` is
 *    `ON DELETE SET NULL` (like `platform_settings.updated_by`) so it survives
 *    erasure of the editor's account.
 * 3. `governance_finance_changes` — one immutable row per changed field,
 *    mirroring `platform_setting_changes` (including `actor_id`
 *    `ON DELETE SET NULL`). This is the per-field trail: who changed which
 *    figure, from what, to what, and why.
 *
 * Applying it changes no visible number: every existing figure keeps its value
 * and is simply labelled `seeded` until an admin edits it.
 */
export class AddGovernanceFinanceProvenance1788800000000 implements MigrationInterface {
  name = 'AddGovernanceFinanceProvenance1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "governance_finance_report_source_enum" AS ENUM('seeded', 'manual', 'computed')`,
    );

    for (const column of [
      'mrr_source',
      'sustainer_count_source',
      'solidarity_rate_source',
      'income_total_source',
      'expense_total_source',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "governance_finance_report" ADD "${column}" "governance_finance_report_source_enum" NOT NULL DEFAULT 'seeded'`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "metrics_edited_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "metrics_edited_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD CONSTRAINT "FK_governance_finance_report_metrics_edited_by" FOREIGN KEY ("metrics_edited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`
      CREATE TABLE "governance_finance_changes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "actor_id" uuid,
        "field" character varying NOT NULL,
        "old_value" text,
        "new_value" text,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_governance_finance_changes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_finance_changes_actor_id" ON "governance_finance_changes" ("actor_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_finance_changes_created_at" ON "governance_finance_changes" ("created_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_changes" ADD CONSTRAINT "FK_governance_finance_changes_actor_id" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_finance_changes" DROP CONSTRAINT "FK_governance_finance_changes_actor_id"`,
    );
    await queryRunner.query(`DROP TABLE "governance_finance_changes"`);

    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP CONSTRAINT "FK_governance_finance_report_metrics_edited_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "metrics_edited_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "metrics_edited_by"`,
    );

    for (const column of [
      'expense_total_source',
      'income_total_source',
      'solidarity_rate_source',
      'sustainer_count_source',
      'mrr_source',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "governance_finance_report" DROP COLUMN "${column}"`,
      );
    }

    await queryRunner.query(
      `DROP TYPE "governance_finance_report_source_enum"`,
    );
  }
}
