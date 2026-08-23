// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-community bans (`community_bans`).
 *
 * Removing someone from a roster used to be the only tool an owner had, and it
 * does not hold: a `public` or `request` community's door is open, so a removed
 * member simply re-joins. This table is the durable record that survives the
 * roster row, and every join path (join, invite accept, join-request approval)
 * consults it.
 *
 * `UQ_community_bans_community_user` makes a ban singular per (community,
 * member): the ban path can upsert against it and two moderators acting at once
 * cannot produce two rows.
 *
 * FK posture follows this module's existing conventions. The community and the
 * banned user CASCADE (a deleted community has no bans to enforce; an erased
 * account cannot walk back in). The MODERATOR is `ON DELETE SET NULL`, the
 * actor-reference convention set by
 * `FixCommunityOwnerAuthorErasureCascades1789900000000`: a moderator erasing
 * their account must never lift the bans they applied.
 *
 * No `CREATE INDEX CONCURRENTLY`: the table is created empty in this same
 * migration, so both indexes build on nothing and the file stays transactional.
 */
export class AddCommunityBans1793800000000 implements MigrationInterface {
  name = 'AddCommunityBans1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "community_bans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "banned_by_user_id" uuid,
        "reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_bans" PRIMARY KEY ("id"),
        CONSTRAINT "FK_community_bans_community" FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_bans_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_bans_banned_by" FOREIGN KEY ("banned_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_community_bans_community_user"
        ON "community_bans" ("community_id", "user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_community_bans_community_id"
        ON "community_bans" ("community_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_bans"`);
  }
}
