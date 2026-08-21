import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lightweight "suggest a tag" feedback pathway: an owner/mod can submit
 * free-text feedback saying they wish a tag existed
 * (`POST /communities/:slug/tag-requests`); an admin reviews the resulting
 * inbox (`GET /admin/community-tag-requests`,
 * `PATCH /admin/community-tag-requests/:id/resolve`).
 *
 * INFORMATIONAL ONLY — deliberate product decision: resolving a request
 * never writes to `COMMUNITY_TAGS` (`src/communities/community-tags.ts`),
 * which stays a hardcoded, code-reviewed array. This table is purely a
 * feedback inbox for admins to read and act on manually in a future,
 * separate code change. Mirrors `community_join_requests`' shape closely —
 * plain `uuid` columns for `community_id`/`requested_by_user_id` (no FK
 * constraint, same as `community_join_requests.user_id`), indexed on both
 * `community_id` and `status` since the admin queue filters on the latter
 * and a future community-scoped view would filter on the former.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCommunityTagRequests1793400000000 implements MigrationInterface {
  name = 'AddCommunityTagRequests1793400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_tag_request_status_enum" AS ENUM (
        'pending', 'resolved'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "community_tag_request" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "requested_by_user_id" uuid NOT NULL,
        "label" character varying(60) NOT NULL,
        "note" character varying(300),
        "status" "community_tag_request_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by_user_id" uuid,
        CONSTRAINT "PK_community_tag_request" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_tag_request_community_id" ON "community_tag_request" ("community_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_tag_request_status" ON "community_tag_request" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_tag_request"`);
    await queryRunner.query(`DROP TYPE "community_tag_request_status_enum"`);
  }
}
