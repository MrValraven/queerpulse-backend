import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `magazine_issue.published_on` becomes nullable.
 *
 * The desk's "New issue" modal demanded a publish date before an issue could
 * exist at all, which had the calendar decide when a number could be opened.
 * Editors open an issue first and schedule it later, so the date is now
 * optional at creation and stays NULL until someone sets it or ships the
 * issue (`MagazinePieceService.shipIssue` already stamps today's date when
 * `publishedOn` is unset — that branch was unreachable until now).
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class MakeMagazineIssuePublishedOnNullable1794540000000 implements MigrationInterface {
  name = 'MakeMagazineIssuePublishedOnNullable1794540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" ALTER COLUMN "published_on" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restoring NOT NULL needs every unscheduled issue to have a date. Today's
    // date is what shipping would have stamped anyway, so it is the one value
    // this revert can pick without inventing an editorial decision.
    await queryRunner.query(
      `UPDATE "magazine_issue" SET "published_on" = CURRENT_DATE WHERE "published_on" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" ALTER COLUMN "published_on" SET NOT NULL`,
    );
  }
}
