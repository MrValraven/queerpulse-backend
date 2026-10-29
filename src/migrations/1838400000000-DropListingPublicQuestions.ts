// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops `listing_public_questions`, the table behind the member-facing public
 * Q&A on listing detail pages ("Ask the owner, in public"). The feature was
 * deleted on the maintainer's call. The SEPARATE `listing_questions` table (the
 * moderator-to-submitter channel used while a listing is under review) is
 * untouched.
 *
 * `up()` removes every row that pointed at the dropped table, in this order:
 *  1. `notifications` rows of type `listing_public_question` and
 *     `listing_public_question_answered`, so no member keeps a notification
 *     whose target no longer exists.
 *  2. `content_moderation` rows with `subject_type = 'listing_public_question'`
 *     (varchar columns `subject_type` / `subject_id`, no FK to the reports
 *     enum), the takedown state keyed by a question's uuid.
 *  3. `reports` rows with `subject_type = 'listing_public_question'`. The three
 *     tables that reference `reports.id` follow their existing FK actions:
 *     `mod_audit_logs.report_id` is ON DELETE CASCADE (the audit rows for these
 *     reports are deleted with them), while `appeals.report_id` and
 *     `ban_ratifications.report_id` are ON DELETE SET NULL (those rows stay and
 *     lose the link).
 *  4. `DROP TABLE "listing_public_questions"`, which drops its primary key, its
 *     three indexes (`IDX_listing_public_questions_listing_id_created_at`,
 *     `IDX_listing_public_questions_asker_id` and the partial
 *     `IDX_listing_public_questions_answered_by_id`) and its three foreign keys.
 *
 * ENUM LABELS STAY. `reports_subject_type_enum.listing_public_question` and
 * `notifications_type_enum.listing_public_question[_answered]` are left in the
 * database on purpose: Postgres cannot drop an enum label without rewriting the
 * enum type, and rewriting `notifications_type_enum` means rewriting the hot
 * `notifications` table. No row can carry these labels after this migration
 * runs, and they are removed from the TypeScript enums only. The next
 * `migration:generate` against a database that still has the labels will
 * propose an enum rebuild; discard that proposal.
 *
 * Fully transactional, with no `CONCURRENTLY`: the deletes and the drop run
 * inside the migration transaction.
 *
 * `down()` restores the SCHEMA only: the table exactly as
 * `CreateListingPublicQuestions1794280000000` created it (same columns,
 * primary key, both indexes and the three foreign keys with their ON DELETE
 * actions) plus the partial index added by
 * `AddContentSocialErasureForeignKeyIndexes1796320000000`. The rows of the
 * dropped table and the deleted `notifications`, `reports` and
 * `content_moderation` rows are NOT restored.
 *
 * BEFORE RUNNING: take a backup (`scripts/pg-backup.sh`) and check
 * `SELECT count(*) FROM listing_public_questions;`. A non-zero count means
 * members wrote public content that this migration destroys for good, so
 * confirm that is intended first.
 */
export class DropListingPublicQuestions1838400000000 implements MigrationInterface {
  name = 'DropListingPublicQuestions1838400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type" IN ('listing_public_question','listing_public_question_answered')`,
    );
    await queryRunner.query(
      `DELETE FROM "content_moderation" WHERE "subject_type" = 'listing_public_question'`,
    );
    await queryRunner.query(
      `DELETE FROM "reports" WHERE "subject_type" = 'listing_public_question'`,
    );
    await queryRunner.query(`DROP TABLE "listing_public_questions"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "listing_public_questions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "asker_id" uuid,
        "asker_name" character varying NOT NULL,
        "body" text NOT NULL,
        "answer" text,
        "answered_at" TIMESTAMP WITH TIME ZONE,
        "answered_by_id" uuid,
        "is_answered_by_moderator" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_public_questions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_public_questions_listing_id_created_at"
         ON "listing_public_questions" ("listing_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_public_questions_asker_id"
         ON "listing_public_questions" ("asker_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_public_questions_answered_by_id"
         ON "listing_public_questions" ("answered_by_id") WHERE "answered_by_id" IS NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "listing_public_questions"
        ADD CONSTRAINT "FK_listing_public_questions_listing_id"
        FOREIGN KEY ("listing_id") REFERENCES "listings"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_public_questions"
        ADD CONSTRAINT "FK_listing_public_questions_asker_id"
        FOREIGN KEY ("asker_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_public_questions"
        ADD CONSTRAINT "FK_listing_public_questions_answered_by_id"
        FOREIGN KEY ("answered_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }
}
