import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `is_official` to `forum_thread`: when true, the thread's author is
 * displayed as "QueerPulse Official" instead of the real poster (see
 * `toForumThreadResponse` in `forum-response.ts`). `author_id` is untouched —
 * it stays the real admin who posted, preserving the audit trail and
 * ownership checks. Not-null with a `false` default so every existing thread
 * lands unaffected.
 */
export class AddForumThreadIsOfficial1791500000000 implements MigrationInterface {
  name = 'AddForumThreadIsOfficial1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "is_official" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "is_official"`,
    );
  }
}
