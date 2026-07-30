import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Self-referential `forum_post.parent_post_id` — the column the Reddit-style
 * nested-replies feature hangs on. `NULL` means a top-level comment on the
 * thread; a value means a reply to that specific post within the same
 * thread. The FK is `ON DELETE SET NULL` (mirroring the soft-tombstone
 * approach in `AddForumPostEditsAndSoftDelete`) rather than `CASCADE` — a
 * deleted parent should not silently delete its replies; they re-parent to
 * the thread root instead.
 */
export class AddForumPostParent1785001900000 implements MigrationInterface {
  name = 'AddForumPostParent1785001900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post" ADD "parent_post_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "forum_post" ADD CONSTRAINT "FK_forum_post_parent_post_id"
        FOREIGN KEY ("parent_post_id") REFERENCES "forum_post"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    // Supports fetching all replies (direct + nested) for a thread ordered
    // by their parent, without a `COUNT(*)`/tree-walk join.
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_post_thread_id_parent_post_id" ON "forum_post" ("thread_id", "parent_post_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_forum_post_thread_id_parent_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP CONSTRAINT "FK_forum_post_parent_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP COLUMN "parent_post_id"`,
    );
  }
}
