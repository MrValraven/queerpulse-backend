import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `magazine_reader_comment` — public reader comments on a published
 * `MagazineArticle` (CNT-10), threaded one level deep via a nullable
 * self-referencing `parent_id` (enforced in
 * `MagazineReaderCommentsService.create`, not the schema). Distinct from
 * `magazine_article_comment` (the staff-only editorial NotesRail) — see that
 * entity's docstring for why this is a new table rather than reusing it.
 *
 * Also adds `magazine_comment` to `reports_subject_type_enum` so a reader
 * comment can be reported (`POST /reports` with
 * `subjectType: "magazine_comment"`) and picked up by the existing mod queue
 * unchanged. Mirrors `AddReviewReportSubject1785800400000`'s precedent: ADDs
 * the value only, never used within this same transaction, so it is safe on
 * Postgres 12+; `down()` for that half is a documented no-op (Postgres has no
 * `ALTER TYPE ... DROP VALUE`).
 *
 * Timestamp note: the plan this migration was authored from assumed
 * `1793000000000` was free (highest migration at the time was
 * `1792900000000-AddMagazineIssueDigestSchedule.ts`), but a concurrent branch
 * has since landed `1793000000000-AddPlatformAnnouncement.ts`. Bumped to
 * `1793100000000` to stay unique and ordered after it.
 */
export class AddMagazineReaderComments1793100000000 implements MigrationInterface {
  name = 'AddMagazineReaderComments1793100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_reader_comment" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "article_id" uuid NOT NULL,
        "parent_id" uuid,
        "author_id" uuid NOT NULL,
        "body" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "edited_at" TIMESTAMP WITH TIME ZONE,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_magazine_reader_comment" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_reader_comment_article_id" ON "magazine_reader_comment" ("article_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_reader_comment_parent_id" ON "magazine_reader_comment" ("parent_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_reader_comment_author_id" ON "magazine_reader_comment" ("author_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "magazine_reader_comment" ADD CONSTRAINT "FK_magazine_reader_comment_article_id"
        FOREIGN KEY ("article_id") REFERENCES "magazine_article"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "magazine_reader_comment" ADD CONSTRAINT "FK_magazine_reader_comment_parent_id"
        FOREIGN KEY ("parent_id") REFERENCES "magazine_reader_comment"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "magazine_reader_comment" ADD CONSTRAINT "FK_magazine_reader_comment_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'magazine_comment'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No-op for the enum half: Postgres cannot drop an enum value;
    // 'magazine_comment' is harmless if left (mirrors
    // `AddReviewReportSubject1785800400000`).
    await queryRunner.query(
      `ALTER TABLE "magazine_reader_comment" DROP CONSTRAINT "FK_magazine_reader_comment_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_reader_comment" DROP CONSTRAINT "FK_magazine_reader_comment_parent_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_reader_comment" DROP CONSTRAINT "FK_magazine_reader_comment_article_id"`,
    );
    await queryRunner.query(`DROP TABLE "magazine_reader_comment"`);
  }
}
