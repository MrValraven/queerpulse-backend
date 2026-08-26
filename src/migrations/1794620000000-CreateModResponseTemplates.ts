import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `mod_response_templates`: the admin-managed library of reusable
 * member-facing decision notes a moderator can prefill into
 * `ModActionDto.note`.
 *
 * WHY. `note` is required on every moderation action and is the exact text the
 * member reads. Typed fresh on every decision, it is the step that gets
 * skipped at volume: the community dismiss path already sends an empty string
 * rather than face it. Skipping it produces the unexplained enforcement the
 * notification pipeline exists to prevent.
 *
 * NOT A FOREIGN KEY ON THE ACTION. Nothing references a template row. The
 * frontend resolves the two placeholders, the moderator edits the result, and
 * the approved text is persisted on the action itself. Editing or deleting a
 * template can therefore never rewrite what a member was already told, which
 * is the whole reason the substitution happens before the send rather than at
 * render time.
 *
 * COLUMNS.
 *  - `reason_code` / `action_code` are plain varchars, nullable. NULL means
 *    "fits any", so one general closing note lives as a single row instead of
 *    being copied across the taxonomy. They are varchar rather than a Postgres
 *    enum for the same reason `reports.reason_code` is: the taxonomies are
 *    TypeScript unions (`REASON_CODES`, `MOD_ACTION_CODES`), and adding a code
 *    should not require a migration here.
 *  - `body` is capped at 2000 in the DTO to match `ModActionDto.note`, so a
 *    template can never prefill a note the action endpoint would reject. The
 *    column stays `text`: the cap belongs with the DTO that mirrors it.
 *  - `created_by_user_id` is `ON DELETE SET NULL`, the actor-FK convention. A
 *    staff member erasing their account must not take the team's response
 *    library with them.
 *
 * INDEXES. `UQ_mod_response_templates_label` keeps picker rows identifiable
 * and gives the starter-set data migration
 * (`SeedModResponseTemplates1794621000000`) a conflict target to be idempotent
 * on. `IDX_mod_response_templates_active_reason` serves the moderator read,
 * which is always "active rows for the reason currently selected".
 * `action_code` is deliberately left out of it: the table holds tens of rows
 * and the reason filter is the selective half.
 *
 * TRANSACTIONAL. One CREATE TABLE, two CREATE INDEXes and one ADD CONSTRAINT,
 * all against an object created in this same transaction, so no
 * `CONCURRENTLY` two-phase split is needed.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class CreateModResponseTemplates1794620000000 implements MigrationInterface {
  name = 'CreateModResponseTemplates1794620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mod_response_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "label" character varying(120) NOT NULL,
        "body" text NOT NULL,
        "reason_code" character varying(40),
        "action_code" character varying(40),
        "sort_order" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mod_response_templates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_mod_response_templates_label"
         ON "mod_response_templates" ("label")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mod_response_templates_active_reason"
         ON "mod_response_templates" ("is_active", "reason_code")`,
    );
    await queryRunner.query(`
      ALTER TABLE "mod_response_templates"
        ADD CONSTRAINT "FK_mod_response_templates_created_by_user_id"
        FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mod_response_templates" DROP CONSTRAINT "FK_mod_response_templates_created_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_mod_response_templates_active_reason"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_mod_response_templates_label"`);
    await queryRunner.query(`DROP TABLE "mod_response_templates"`);
  }
}
