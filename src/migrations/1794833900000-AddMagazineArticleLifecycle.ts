// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CON-16 — a content lifecycle for `magazine_article`, so retiring a piece
 * stops meaning deleting it from the archive.
 *
 * Before this, publish state was a single nullable `published_at`. An editor
 * who no longer stood by a 2024 piece about name-change paperwork had exactly
 * one tool: unpublish it. That 404s every link anyone shared, removes the
 * piece from the archive, and tells the reader nothing about WHY. For a
 * magazine whose subjects are law, healthcare access and organisations that
 * reorganise, that is the wrong shape entirely: the piece is usually still
 * worth reading, it just needs to say when it was true.
 *
 * FIVE COLUMNS
 *  - `lifecycle` — 'live' | 'under_review' | 'archived' | 'superseded'.
 *    Defaults to 'live' and every existing row takes that default, which is
 *    exactly what they were.
 *  - `lifecycle_note` — the editor's own sentence for the banner.
 *  - `lifecycle_changed_at` — the DATE in "dated banner". NULL until a piece
 *    first leaves 'live', so no existing row gains a fabricated date.
 *  - `review_due_on` — the scheduled re-review the desk promised itself. A
 *    `date`: "re-check in six months" has no clock time.
 *  - `superseded_by_article_id` — the replacement piece, for the state that
 *    has one.
 *
 * WHY VARCHAR AND NOT A POSTGRES ENUM
 * Matching every other status column in this schema (`magazine_piece.stage`,
 * `magazine_story_submission.status`). A Postgres enum needs its own
 * migration to gain a value and cannot lose one at all; the set of lifecycle
 * states is editorial policy and will move. The application validates against
 * `ARTICLE_LIFECYCLES`, and the CHECK constraint below keeps the column
 * honest against anything that reaches it another way.
 *
 * INDEXES
 * `lifecycle` gets a plain index: the desk's lifecycle board filters on
 * "everything not live", which is a small minority of a table already only
 * hundreds of rows deep. `review_due_on` gets a PARTIAL index (`WHERE
 * review_due_on IS NOT NULL`) because the review queue's only query is
 * `review_due_on <= :horizon ORDER BY review_due_on`, and most pieces will
 * never carry a review date at all.
 *
 * The FK is `ON DELETE SET NULL`: deleting the replacement piece must not
 * cascade a delete through the archive. The superseded piece stays superseded
 * with no target, and its banner degrades to its note.
 *
 * LOCKING
 * Five nullable/defaulted column adds on an editorial table of hundreds of
 * rows. Postgres 11+ stores a non-volatile column default in the catalog
 * rather than rewriting the heap, so this is a brief ACCESS EXCLUSIVE lock,
 * and a plain transactional migration is correct.
 */
export class AddMagazineArticleLifecycle1794833900000 implements MigrationInterface {
  name = 'AddMagazineArticleLifecycle1794833900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD "lifecycle" character varying(24) NOT NULL DEFAULT 'live'`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD CONSTRAINT "CHK_magazine_article_lifecycle" CHECK ("lifecycle" IN ('live', 'under_review', 'archived', 'superseded'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD "lifecycle_note" character varying(500) NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD "lifecycle_changed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD "review_due_on" date`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD "superseded_by_article_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD CONSTRAINT "FK_magazine_article_superseded_by" FOREIGN KEY ("superseded_by_article_id") REFERENCES "magazine_article"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_lifecycle" ON "magazine_article" ("lifecycle")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_review_due_on" ON "magazine_article" ("review_due_on") WHERE "review_due_on" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_magazine_article_review_due_on"`);
    await queryRunner.query(`DROP INDEX "IDX_magazine_article_lifecycle"`);
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP CONSTRAINT "FK_magazine_article_superseded_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "superseded_by_article_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "review_due_on"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "lifecycle_changed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "lifecycle_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP CONSTRAINT "CHK_magazine_article_lifecycle"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "lifecycle"`,
    );
  }
}
