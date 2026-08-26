import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Triage provenance for the two ops inboxes an admin console now reads:
 * `inquiries` (the public Contact + For-Organisations forms) and
 * `intake_submissions` (the twelve generic intake forms).
 *
 * WHY. Both tables already carried a `status`, and nothing recorded WHO moved
 * it or WHEN. With two or more admins working the same pile that is the
 * difference between a queue and a guess: an inquiry reading `handled` with no
 * name attached cannot be followed up, re-opened, or handed over. QueerPulse
 * sends no email, so an unanswered form is a permanently dropped relationship —
 * the console needs to show accountability, not just a flag.
 *
 * BOTH FOREIGN KEYS ARE `ON DELETE SET NULL`, never CASCADE. The triaging admin
 * is not the owner of the record: erasing a staff account must de-link the
 * triage stamp, never delete the member's message or submission (same rule as
 * `intake_submissions.submitter_id`).
 *
 * NO STATUS BACKFILL. Existing rows that are already `handled` / `reviewed`
 * keep a null handler and a null timestamp: nothing in the data says who did
 * it, and inventing an attribution would be worse than an honest blank. The
 * console renders those as "handled (no record)".
 *
 * `IDX_inquiries_status_created_at` is the index behind the console's default
 * read — equality on `status`, then a backwards scan for `ORDER BY created_at
 * DESC`. The pre-existing single-column `IDX_inquiries_status` is deliberately
 * left in place: dropping an index an applied migration created is churn this
 * read does not need. The two `*_by_id` indexes back the `ON DELETE SET NULL`
 * de-link scan, mirroring `IDX_intake_submissions_submitter_id`.
 *
 * Purely additive and transactional — no enum is touched, so nothing here needs
 * the non-transactional runbook.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddInquiryAndIntakeTriageColumns1795410000000 implements MigrationInterface {
  name = 'AddInquiryAndIntakeTriageColumns1795410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "inquiries" ADD "handled_by_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "inquiries" ADD "handled_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_inquiries_handled_by_id" ON "inquiries" ("handled_by_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_inquiries_status_created_at" ON "inquiries" ("status", "created_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "inquiries" ADD CONSTRAINT "FK_inquiries_handled_by_id" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "intake_submissions" ADD "reviewed_by_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" ADD "reviewed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_intake_submissions_reviewed_by_id" ON "intake_submissions" ("reviewed_by_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" ADD CONSTRAINT "FK_intake_submissions_reviewed_by_id" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" DROP CONSTRAINT "FK_intake_submissions_reviewed_by_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_intake_submissions_reviewed_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" DROP COLUMN "reviewed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" DROP COLUMN "reviewed_by_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "inquiries" DROP CONSTRAINT "FK_inquiries_handled_by_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_inquiries_status_created_at"`);
    await queryRunner.query(`DROP INDEX "IDX_inquiries_handled_by_id"`);
    await queryRunner.query(`ALTER TABLE "inquiries" DROP COLUMN "handled_at"`);
    await queryRunner.query(
      `ALTER TABLE "inquiries" DROP COLUMN "handled_by_id"`,
    );
  }
}
