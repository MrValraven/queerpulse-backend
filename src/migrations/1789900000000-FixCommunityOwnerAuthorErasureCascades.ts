import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the Communities-feature audit's single most consequential finding:
 * `communities.owner_id` (`AddCommunities1782693200000`) was `ON DELETE
 * CASCADE` to `users`, so erasing a community owner's account cascaded and
 * deleted the ENTIRE community — every post, reply, reaction, member, and
 * join request in it. Every other actor-reference in this feature (e.g.
 * `community_post_edit.editor_id`, added by the same later migration that
 * introduced soft-delete) is deliberately `ON DELETE SET NULL` "for account
 * erasure"; the owner FK was the one exception, and the one that mattered
 * most.
 *
 * `community_posts.author_id` / `community_post_replies.author_id` were also
 * `ON DELETE CASCADE`, so an author's account erasure hard-deleted their
 * posts/replies instead of tombstoning them — inconsistent with this
 * feature's own soft-delete design (member-initiated deletes preserve the
 * body as "[deleted]" with full edit history via `community_post_edit` /
 * `community_post_reply_edit`).
 *
 * `community_members.user_id` is deliberately left `ON DELETE CASCADE` — a
 * membership row genuinely doesn't make sense without a user, and cascading
 * it is equivalent to the member having left, which is correct.
 *
 * All three columns become nullable + `SET NULL`, mirroring the pattern
 * `AddDeletionErasureSupport1782800700000` set for `reports.reporter_id` /
 * `mod_audit_logs.actor_id`. The orphaned-owner case then needs handling
 * beyond "leave it NULL": `CommunityOwnerOrphanService.handleOwnerErasure`
 * promotes the roster's longest-tenured `mod` to owner, or — if none exists —
 * leaves `owner_id` NULL and stamps the new `needs_owner_review_at` column so
 * an admin surface can later query for ownerless communities.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class FixCommunityOwnerAuthorErasureCascades1789900000000
  implements MigrationInterface
{
  name = 'FixCommunityOwnerAuthorErasureCascades1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- communities.owner_id: CASCADE -> SET NULL -----------------------------
    await queryRunner.query(
      `ALTER TABLE "communities" DROP CONSTRAINT "FK_communities_owner_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ALTER COLUMN "owner_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "communities" ADD CONSTRAINT "FK_communities_owner_id"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- communities.needs_owner_review_at: ownerless-triage marker -----------
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "needs_owner_review_at" TIMESTAMP WITH TIME ZONE`,
    );

    // --- community_posts.author_id: CASCADE -> SET NULL ------------------------
    await queryRunner.query(
      `ALTER TABLE "community_posts" DROP CONSTRAINT "FK_community_posts_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" ALTER COLUMN "author_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_posts" ADD CONSTRAINT "FK_community_posts_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- community_post_replies.author_id: CASCADE -> SET NULL -----------------
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" DROP CONSTRAINT "FK_community_post_replies_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" ALTER COLUMN "author_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_post_replies" ADD CONSTRAINT "FK_community_post_replies_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // --- community_post_replies.author_id: SET NULL -> CASCADE -----------------
    // Reverting the nullability only succeeds while no row has actually been
    // NULLed by an erasure — same caveat as `AddDeletionErasureSupport`'s
    // down(). Once an author has been erased, `SET NOT NULL` correctly fails
    // rather than silently resurrecting an author_id that no longer exists.
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" DROP CONSTRAINT "FK_community_post_replies_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" ALTER COLUMN "author_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_post_replies" ADD CONSTRAINT "FK_community_post_replies_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // --- community_posts.author_id: SET NULL -> CASCADE -------------------------
    await queryRunner.query(
      `ALTER TABLE "community_posts" DROP CONSTRAINT "FK_community_posts_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" ALTER COLUMN "author_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_posts" ADD CONSTRAINT "FK_community_posts_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // --- communities.needs_owner_review_at --------------------------------------
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "needs_owner_review_at"`,
    );

    // --- communities.owner_id: SET NULL -> CASCADE ------------------------------
    await queryRunner.query(
      `ALTER TABLE "communities" DROP CONSTRAINT "FK_communities_owner_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ALTER COLUMN "owner_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "communities" ADD CONSTRAINT "FK_communities_owner_id"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }
}
