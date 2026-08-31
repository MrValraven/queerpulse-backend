// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retrofits the missing `users("id")` foreign keys on the magazine desk's
 * three author columns (ENG-33).
 *
 * WHY. `AddMagazineArticleComment1787100000000`,
 * `AddMagazineArticleVersion1787200000000` and
 * `AddMagazinePieceMessage1787300000000` each declared their user reference as
 * a bare `uuid`, reasoning by analogy with `article_id`/`piece_id` (which
 * point at magazine tables, where the module's no-relation convention is a
 * deliberate choice). A user reference is a different case: `users` rows are
 * genuinely hard-deleted by
 * `AccountDeletionProcessorService.eraseAccount`, which relies on the FK graph
 * to decide what an erasure takes with it. With no constraint on these three
 * columns an erasure silently left an editorial comment thread, a version
 * history and a private desk thread behind, each attributed to an id that
 * resolves to nothing. The module is NOT foreign-key-free overall, which is
 * exactly what made the gap easy to miss: `magazine_reader_comment.author_id`,
 * `magazine_writer_applications.user_id`/`reviewed_by` and
 * `magazine_author.user_id` all carry proper FKs already.
 *
 * The scan that raised this counted four columns across the two comment and
 * message migrations. Those two tables carry exactly two user columns between
 * them; the third fixed here, `magazine_article_version.author_id`, is the
 * same defect in the sibling migration authored between them. Two further desk
 * columns are deliberately NOT touched here, see "LEFT ALONE" below.
 *
 * ON DELETE, DECIDED PER COLUMN RATHER THAN IN BULK.
 *
 *  - `magazine_article_comment.author_id` -> SET NULL. The NotesRail is a
 *    shared editorial conversation: comments are threaded, other editors reply
 *    to them, and a piece ships on the back of them. Cascading would delete one
 *    editor's half of a review thread, and because `parent_id` carries no
 *    constraint of its own it would leave that comment's replies pointing at a
 *    parent that no longer exists, so `toArticleCommentTree` would silently
 *    re-render them as top-level notes with no context. Nulling the byline
 *    keeps the thread whole and readable. Precedent:
 *    `SetNullContentAuthorFksOnUserErasure1794610000000`, which made exactly
 *    this call for eleven columns of content other members depend on.
 *
 *  - `magazine_article_version.author_id` -> SET NULL. A version snapshot is
 *    restorable content, not a byline: deleting the snapshots one editor
 *    happened to save would remove restore points other people still rely on.
 *    Already nullable by design (an automatic snapshot has no human actor) and
 *    `resolveVersionAuthorName` in `magazine-article-version-response.ts`
 *    already renders `null` as a neutral label, so this column needed no
 *    schema or read-path change at all.
 *
 *  - `magazine_piece_message.author_id` -> CASCADE. This is the desk's private
 *    correspondence, readable only by the piece's assigned editor/admin and its
 *    assigned writer (`assertPieceThreadAccess`). QueerPulse already decided
 *    what erasure means for private correspondence:
 *    `messages.sender_id` has been `ON DELETE CASCADE` since
 *    `AddMessaging1782691800000`, so an erased member's direct messages go with
 *    them. A commissioning thread is the same promise in a different surface,
 *    and treating it differently would mean a member who erased their account
 *    still had their private messages readable by whoever the piece is
 *    reassigned to. Keeping CASCADE also keeps the column NOT NULL, which is
 *    what `PieceMessageResponse.fromMe` compares against.
 *
 * NULLABILITY. `magazine_article_comment.author_id` was created NOT NULL, and
 * a SET NULL rule on a NOT NULL column is a constraint Postgres accepts at DDL
 * time and only fails on at delete time (the same trap
 * `SetNullContentAuthorFksOnUserErasure1794610000000` documents). It is dropped
 * to nullable here, and the entity plus the two read paths that dereference it
 * are updated in the same change.
 *
 * ORPHANS FIRST. `ADD CONSTRAINT` is validated against existing data, so any
 * row already pointing at an erased account would fail the ALTER. Those rows
 * are unreachable content today: their author id resolves to no `users` row,
 * no `Profile` and no editor-directory entry, so every read path already
 * renders them under a fallback label. Each column is therefore repaired to
 * the state its new rule would have produced (nulled for the two SET NULL
 * columns, deleted for the CASCADE one) before the constraint is added, rather
 * than letting the migration fail on data the schema was never protecting.
 *
 * INDEXES. None of the three columns was indexed. A SET NULL or CASCADE rule
 * makes Postgres look the child rows up on every `users` delete, which without
 * an index is a sequential scan of the whole table per erasure. Each column
 * gets one, matching `AddUserRefForeignKeys1785600300000`'s convention.
 *
 * LEFT ALONE, deliberately. `magazine_piece.editor_id`/`writer_id` are
 * assignment columns rather than authorship, and deciding what happens to a
 * commissioned piece whose editor erases their account is a desk workflow
 * question (reassign? unassign? close?) that belongs with
 * `ContentOwnerErasureService`, not with a constraint. `magazine_piece_event`
 * `.actor_id` is left too: it is already nullable, but `null` there is a
 * documented "System" sentinel (`toEventActorLabel` returns "System" and the
 * response sets `isSystem: true`), so a SET NULL rule would relabel an erased
 * person's audit entries as system actions. That needs a separate sentinel to
 * tell "no human" from "erased human" apart before it can carry an FK.
 *
 * ENTITY METADATA. The magazine module declares FK-backed user columns as a
 * plain `@Column` plus `@Index`, never a `@ManyToOne` relation:
 * `MagazineReaderComment.authorId` and
 * `MagazineWriterApplication.userId`/`reviewedBy` are all constrained in the
 * schema and relation-free on the entity. The three entities touched here
 * follow that convention rather than introducing the module's first relation.
 * The tradeoff is the module's existing one: `migration:generate` does not see
 * these constraints in the entity metadata, so its diff must not be trusted to
 * drop them.
 *
 * Purely transactional DDL: `ALTER TABLE`, plain `CREATE INDEX` (never
 * `CONCURRENTLY`), and three small repair statements. All four tables are
 * editorial-desk sized, so a brief write lock is not worth the two-phase
 * `CONCURRENTLY` runbook.
 */
export class AddMagazineDeskAuthorForeignKeys1795810000000 implements MigrationInterface {
  name = 'AddMagazineDeskAuthorForeignKeys1795810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- magazine_article_comment.author_id -> SET NULL ---------------------
    await queryRunner.query(
      `ALTER TABLE "magazine_article_comment" ALTER COLUMN "author_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      UPDATE "magazine_article_comment" SET "author_id" = NULL
        WHERE "author_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "users"
              WHERE "users"."id" = "magazine_article_comment"."author_id"
          )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_comment_author_id" ON "magazine_article_comment" ("author_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "magazine_article_comment"
        ADD CONSTRAINT "FK_magazine_article_comment_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- magazine_article_version.author_id -> SET NULL ---------------------
    await queryRunner.query(`
      UPDATE "magazine_article_version" SET "author_id" = NULL
        WHERE "author_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "users"
              WHERE "users"."id" = "magazine_article_version"."author_id"
          )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_version_author_id" ON "magazine_article_version" ("author_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "magazine_article_version"
        ADD CONSTRAINT "FK_magazine_article_version_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- magazine_piece_message.author_id -> CASCADE ------------------------
    // Deleted rather than nulled: CASCADE is the rule chosen for this column,
    // so a message whose author is already gone is a row the new constraint
    // would never have allowed to survive.
    await queryRunner.query(`
      DELETE FROM "magazine_piece_message"
        WHERE NOT EXISTS (
          SELECT 1 FROM "users"
            WHERE "users"."id" = "magazine_piece_message"."author_id"
        )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_piece_message_author_id" ON "magazine_piece_message" ("author_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "magazine_piece_message"
        ADD CONSTRAINT "FK_magazine_piece_message_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_piece_message" DROP CONSTRAINT "FK_magazine_piece_message_author_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_magazine_piece_message_author_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "magazine_article_version" DROP CONSTRAINT "FK_magazine_article_version_author_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_magazine_article_version_author_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "magazine_article_comment" DROP CONSTRAINT "FK_magazine_article_comment_author_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_magazine_article_comment_author_id"`,
    );
    // Same caveat as `SetNullContentAuthorFksOnUserErasure1794610000000`'s
    // down(): restoring NOT NULL only succeeds while no comment has actually
    // been nulled by an erasure. Once an author has been erased this correctly
    // fails rather than silently resurrecting an id that no longer exists.
    await queryRunner.query(
      `ALTER TABLE "magazine_article_comment" ALTER COLUMN "author_id" SET NOT NULL`,
    );
  }
}
