import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two columns that make a freeze legible: `communities.frozen_note` and
 * `communities.frozen_by_user_id`.
 *
 * A frozen community currently goes quiet with no explanation, which reads to
 * its members as the platform breaking rather than as a deliberate pause.
 * `frozen_note` is a short PUBLIC line a moderator can attach in the
 * community's own words ("paused while we rewrite the rules", "on hold until
 * the March meeting"), shown to everyone who can see the community. Because it
 * is public it holds no moderation detail: why a freeze happened stays in
 * `frozen_reason` and the governance log.
 *
 * `frozen_by_user_id` records who applied it. `ON DELETE SET NULL` for account
 * erasure, the actor-reference convention this module follows
 * (`FixCommunityOwnerAuthorErasureCascades1789900000000`): a moderator erasing
 * their account must not lift the freeze they applied. It is also NULL for an
 * automatic freeze, which no person applied, and `frozen_reason` is what
 * distinguishes those two NULLs.
 *
 * Both nullable and cleared alongside `frozen_at` when a freeze is lifted, so
 * `ADD COLUMN` is metadata-only with nothing to backfill.
 */
export class AddCommunityFrozenNote1793900000000 implements MigrationInterface {
  name = 'AddCommunityFrozenNote1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "frozen_note" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "frozen_by_user_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "communities"
        ADD CONSTRAINT "FK_communities_frozen_by"
        FOREIGN KEY ("frozen_by_user_id")
        REFERENCES "users"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP CONSTRAINT "FK_communities_frozen_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "frozen_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "frozen_note"`,
    );
  }
}
