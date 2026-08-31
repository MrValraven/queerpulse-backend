// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two missing `users("id")` foreign keys on `community_tag_request`
 * (ENG-35).
 *
 * WHY. `AddCommunityTagRequests1793400000000` declared
 * `requested_by_user_id` (NOT NULL) and `resolved_by_user_id` as bare `uuid`
 * columns, copying `community_join_requests`' shape, and the entity's own
 * comment justified it as "history should outlive the account". Nothing
 * deletes the row, so an erasure left the member's free-text `label` and
 * `note` sitting in the admin inbox keyed to an id that resolves to nothing:
 * `MemberLookup.byUserIds` finds no profile, the requester ref serializes as
 * `null`, and the row reads as feedback from nobody. That is not history
 * outliving an account, it is an unowned row nobody can act on.
 *
 * TWO COLUMNS, TWO DIFFERENT RULES.
 *
 *  - `requested_by_user_id` -> CASCADE. A tag request is deliberately a
 *    one-person loop, not shared history. It is INFORMATIONAL ONLY by product
 *    decision: resolving one never writes to `COMMUNITY_TAGS`
 *    (`src/communities/community-tags.ts` stays a hardcoded, code-reviewed
 *    array), nothing references the row, no other member sees it, and the only
 *    thing resolution produces is a `CommunityTagRequestResolved` notification
 *    back to the person who filed it. With that person erased the row is a dead
 *    letter: an admin cannot close the loop, and what remains is 360
 *    characters of free text the member wrote about themselves and their
 *    community. Erasure should take it. This matches how every other
 *    one-person request row behaves on erasure (`job_applications`,
 *    `volunteer_signups`, `member_verifications`, `data_export_job`), and it
 *    keeps the column NOT NULL, so the notify path in
 *    `AdminCommunityTagRequestsService.resolve` still has a real recipient.
 *
 *    The alternative considered was making the column nullable and using SET
 *    NULL, matching `listing_edit_suggestions.suggested_by_user_id`
 *    (`AddUserRefForeignKeys1785600300000`). Rejected because that column is
 *    genuinely shared: a listing edit suggestion changes a directory entry
 *    every member reads, so the suggestion is worth keeping after its author
 *    leaves. A tag request changes nothing by design. Taking the SET NULL route
 *    would also mean a nullable recipient for a notification whose entire
 *    purpose is reaching one specific person.
 *
 *  - `resolved_by_user_id` -> SET NULL. This is a moderation stamp, and the
 *    repo has one settled rule for those: moderation history survives erasure
 *    severed from the person, never deleted with them. `mod_audit_logs.actor_id`
 *    is SET NULL for exactly this reason (see the reasoning in
 *    `AccountDeletionProcessorService.eraseAccount` step 2: an erased moderator
 *    must not take the record of their decisions with them), as is
 *    `listing_edit_suggestions.resolved_by_user_id` and
 *    `magazine_writer_applications.reviewed_by`. Cascading here would be worse
 *    than losing the stamp: it would let an admin delete other people's pending
 *    feedback by erasing their own account. Already nullable, so no schema
 *    change, and the column is never serialized
 *    (`admin-community-tag-requests-response.ts` deliberately withholds it), so
 *    no read path changes either.
 *
 * The two rules interact in the obvious way and that is intended: if the
 * requester erases, the row goes and the resolver's stamp goes with it, because
 * the stamp only ever existed as part of that row. The durable moderation
 * record lives in `mod_audit_logs`, which is untouched by either delete.
 *
 * ORPHANS FIRST. `ADD CONSTRAINT` is validated against existing data. Rows
 * whose `requested_by_user_id` already points at an erased account are exactly
 * the rows this migration exists to stop accumulating: no profile resolves, the
 * admin inbox already renders them with a `null` requester, and the resolve
 * endpoint would notify an account that does not exist. They are deleted, which
 * is the state the new CASCADE rule would have produced. A dangling
 * `resolved_by_user_id` is nulled, likewise matching its new rule.
 *
 * INDEXES. Neither column was indexed (the table only indexes `community_id`
 * and `status`, for the admin queue's filters). Both a CASCADE and a SET NULL
 * rule make Postgres look up child rows on every `users` delete, so both get
 * one, matching `AddUserRefForeignKeys1785600300000`.
 *
 * ENTITY METADATA. `src/communities/entities/*` declares no `@ManyToOne`
 * relations anywhere, only plain `uuid` columns, so `CommunityTagRequest` keeps
 * that shape and gains `@Index` decorators for the two new indexes. As
 * elsewhere in this module, `migration:generate`'s diff must not be trusted to
 * drop constraints it cannot see in the metadata.
 *
 * Purely transactional DDL: two `ALTER TABLE ... ADD CONSTRAINT`, two plain
 * `CREATE INDEX` (never `CONCURRENTLY`), and two small repair statements. The
 * table is a low-volume feedback inbox, so the brief write lock is not worth a
 * two-phase runbook.
 */
export class AddCommunityTagRequestUserForeignKeys1795811000000 implements MigrationInterface {
  name = 'AddCommunityTagRequestUserForeignKeys1795811000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- requested_by_user_id -> CASCADE ------------------------------------
    await queryRunner.query(`
      DELETE FROM "community_tag_request"
        WHERE NOT EXISTS (
          SELECT 1 FROM "users"
            WHERE "users"."id" = "community_tag_request"."requested_by_user_id"
        )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_tag_request_requested_by_user_id" ON "community_tag_request" ("requested_by_user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_tag_request"
        ADD CONSTRAINT "FK_community_tag_request_requested_by_user_id"
        FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // --- resolved_by_user_id -> SET NULL ------------------------------------
    await queryRunner.query(`
      UPDATE "community_tag_request" SET "resolved_by_user_id" = NULL
        WHERE "resolved_by_user_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "users"
              WHERE "users"."id" = "community_tag_request"."resolved_by_user_id"
          )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_tag_request_resolved_by_user_id" ON "community_tag_request" ("resolved_by_user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_tag_request"
        ADD CONSTRAINT "FK_community_tag_request_resolved_by_user_id"
        FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_tag_request" DROP CONSTRAINT "FK_community_tag_request_resolved_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_community_tag_request_resolved_by_user_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "community_tag_request" DROP CONSTRAINT "FK_community_tag_request_requested_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_community_tag_request_requested_by_user_id"`,
    );
  }
}
