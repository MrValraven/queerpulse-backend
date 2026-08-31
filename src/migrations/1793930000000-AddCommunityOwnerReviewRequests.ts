import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `community_owner_review_requests`: a community's moderators jointly flagging
 * that their owner has gone unreachable, so platform staff can look at
 * reassigning the community.
 *
 * `communities.needs_owner_review_at` already existed, but exactly one path
 * stamped it: `CommunityOwnerOrphanService.handleOwnerErasure`, an owner who
 * deleted their account leaving no mod to promote. The far commoner failure is
 * an owner who simply stopped showing up, which nothing on the platform could
 * express. Filing a request here stamps that same column and notifies platform
 * staff (`community_owner_review_requested`), so both routes land on one admin
 * surface.
 *
 * `UQ_community_owner_review_requests_open` is a PARTIAL unique index
 * (`WHERE status = 'open'`): one community can carry at most one OPEN request,
 * so a second moderator filing while one is already open collides instead of
 * stacking duplicates on the staff queue. Closed requests (`resolved`,
 * `withdrawn`) stay as history and do not block a later re-flag. Same
 * precedent as `UQ_community_join_requests_pending`
 * (`AddCommunities1782693200000`) and `UQ_reports_open_reporter_subject`.
 *
 * The community FK CASCADEs (a deleted community has nothing left to review);
 * the requester FK is `ON DELETE SET NULL`, this module's actor-reference
 * convention, so the request outlives the moderator's account.
 *
 * No `CREATE INDEX CONCURRENTLY`: the table is created empty in this same
 * migration, so both indexes build on nothing and the file stays transactional.
 */
export class AddCommunityOwnerReviewRequests1793930000000 implements MigrationInterface {
  name = 'AddCommunityOwnerReviewRequests1793930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_owner_review_requests_status_enum" AS ENUM
        ('open', 'resolved', 'withdrawn')
    `);
    await queryRunner.query(`
      CREATE TABLE "community_owner_review_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "requested_by_user_id" uuid,
        "reason" text,
        "status" "community_owner_review_requests_status_enum"
          NOT NULL DEFAULT 'open',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_community_owner_review_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_community_owner_review_requests_community"
          FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_owner_review_requests_requested_by"
          FOREIGN KEY ("requested_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_community_owner_review_requests_community_id"
        ON "community_owner_review_requests" ("community_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_community_owner_review_requests_open"
        ON "community_owner_review_requests" ("community_id")
        WHERE "status" = 'open'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_owner_review_requests"`);
    await queryRunner.query(
      `DROP TYPE "community_owner_review_requests_status_enum"`,
    );
  }
}
