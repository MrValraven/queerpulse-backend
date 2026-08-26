// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops `email_preference`, the per-(user, category) email-notification toggle
 * table created by `AddAccountManagement1782800030000`.
 *
 * WHY THE ROWS GO RATHER THAN STAY
 *
 * QueerPulse delivers no email and never will, and the privacy policy now says
 * so plainly. The table was written only by `PATCH /account/email-preferences`
 * and read only by `GET /account/email-preferences`; both routes are removed in
 * the same change, so after this there is no writer and no reader anywhere in
 * the codebase. It was never in the Art. 20 data export either
 * (`src/account/data-export-contributors.ts` has no contributor for it), so the
 * rows were personal data a member could not even see on a subject-access
 * request.
 *
 * The one real argument for keeping them is that a member who turned a category
 * off expressed a preference, and a preference deserves to survive. It does not
 * survive here, because dropping these rows can only ever fail SAFE. Every
 * stored row says either "send me this" (impossible, and always was) or "do not
 * send me this" (which the platform satisfies by sending nothing at all,
 * forever). There is no state in which losing a row causes a member to receive
 * something they declined. What is left is personal data with no purpose, no
 * reader and no retention rule, which is exactly what `docs/ops/retention-
 * periods.md` exists to catch.
 *
 * Leaving the table would also be a live maintenance trap: an unreferenced
 * table with a `users` FK still participates in every erasure cascade, every
 * schema diff and every audit, and it invites a future reader to treat it as
 * evidence that email preferences mean something.
 *
 * REVERSIBILITY. `down()` recreates the table exactly as it stands today: the
 * shape from `AddAccountManagement1782800030000` (`email_preference` was
 * deliberately excluded from `AddCreatedAtToRowAccretingTables1785004500000`,
 * so it has no `created_at`), both indexes, and the cascading FK to `users`.
 * A revert therefore restores the schema and boots clean. It does not restore
 * the rows; those are recoverable only from a database backup
 * (`docs/ops/backup-restore.md`).
 *
 * Purely transactional DDL: one `DROP TABLE`, no `CREATE INDEX CONCURRENTLY`,
 * so this runs inside the migration transaction like any other.
 */
export class DropEmailPreference1795740000000 implements MigrationInterface {
  name = 'DropEmailPreference1795740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Dropping the table takes its indexes and its FK constraint with it.
    await queryRunner.query(`DROP TABLE "email_preference"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_preference" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "category" character varying NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_preference" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_preference_user_id_category" ON "email_preference" ("user_id", "category")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_preference_user_id" ON "email_preference" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_preference" ADD CONSTRAINT "FK_email_preference_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
