import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `magazine_author.user_id`: the member account a byline belongs to (CON-11).
 *
 * `magazine_author` was deliberately decoupled from member accounts, so a
 * published byline attached to nothing: the author page showed a bare name,
 * the article's author-bio block rendered empty, and a member who wrote for
 * the magazine got no credit on their profile and no link back. This column
 * is the link, populated when a commissioned piece's writer is a member whose
 * display name matches the piece byline.
 *
 * Nullable with no default and nothing to backfill: a contributor credited by
 * name only genuinely has no account, and NULL is exactly that. Existing rows
 * stay unlinked until a staff editor links them or the writer files their
 * next piece.
 *
 * FK is `ON DELETE SET NULL`, matching `SetNullContentAuthorFksOnUserErasure`:
 * erasing an account unlinks the byline and leaves the published credit
 * standing rather than deleting editorial history.
 *
 * The unique index is PARTIAL (`WHERE "user_id" IS NOT NULL`) so a member
 * holds at most one byline while the many name-only bylines all keep their
 * NULL. It also serves the `WHERE user_id = $1` lookup behind
 * `GET /magazine/authors/me` and the profile's Writing surface.
 */
export class AddMagazineAuthorUserId1794833300000 implements MigrationInterface {
  name = 'AddMagazineAuthorUserId1794833300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "magazine_author" ADD "user_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "magazine_author" ADD CONSTRAINT "FK_magazine_author_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_author_user_id" ON "magazine_author" ("user_id") WHERE "user_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_magazine_author_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "magazine_author" DROP CONSTRAINT "FK_magazine_author_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_author" DROP COLUMN "user_id"`,
    );
  }
}
