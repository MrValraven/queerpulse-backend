import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `intake_submissions` — one row per submission through any of the generic
 * intake forms (grant applications, glossary edit suggestions, sober-host and
 * panel signups, and the three incubator forms). One table backs every form:
 * `kind` (varchar, allowlist-enforced in the app, not a PG enum) says which
 * form produced the row and `payload` (jsonb) carries that form's fields.
 *
 * `submitter_id` is a NULLABLE FK → `users(id)` with `ON DELETE SET NULL`:
 * public forms accept anonymous submissions (null) and erasing a member must
 * de-link — never delete — the ops record of their submission. `status` starts
 * `new` and staff flip it to `reviewed` during triage. The three indexes back
 * the admin triage list's filters (kind / status) and the submitter de-link.
 */
export class CreateIntakeSubmissions1786001400000 implements MigrationInterface {
  name = 'CreateIntakeSubmissions1786001400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "intake_submissions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" character varying NOT NULL,
        "submitter_id" uuid,
        "payload" jsonb NOT NULL,
        "status" character varying NOT NULL DEFAULT 'new',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_intake_submissions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_intake_submissions_kind" ON "intake_submissions" ("kind")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_intake_submissions_submitter_id" ON "intake_submissions" ("submitter_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_intake_submissions_status" ON "intake_submissions" ("status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" ADD CONSTRAINT "FK_intake_submissions_submitter_id" FOREIGN KEY ("submitter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" DROP CONSTRAINT "FK_intake_submissions_submitter_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_intake_submissions_status"`);
    await queryRunner.query(`DROP INDEX "IDX_intake_submissions_submitter_id"`);
    await queryRunner.query(`DROP INDEX "IDX_intake_submissions_kind"`);
    await queryRunner.query(`DROP TABLE "intake_submissions"`);
  }
}
