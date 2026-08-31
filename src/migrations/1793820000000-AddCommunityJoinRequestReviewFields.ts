import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The fields community join-request review has been missing on both sides of
 * the conversation.
 *
 * `involvement` is the applicant's own answer to "how do you want to take
 * part", asked in the join modal. Its labels mirror the frontend's
 * `INVOLVEMENT` list (`src/features/communities/joinModal.data.ts`) exactly,
 * because those `value` strings are what gets stored. Nullable: the question is
 * optional, and no request filed before today has an answer.
 *
 * `decline_reason` / `decline_kind` / `reapply_after` give a decline a shape.
 * Until now a decline was a bare status: the applicant learned only that the
 * answer was no, with no word on whether trying again was welcome. `not_now`
 * is a timing answer and pairs with `reapply_after`; `not_a_fit` is a fit
 * answer and carries no invitation to return. A permanent bar is a ban
 * (`community_bans`), never a decline.
 *
 * All four columns are nullable with no default: they describe events that
 * have not happened for a pending request and did not exist for any historic
 * one, so `ADD COLUMN` is metadata-only and no backfill is needed or wanted.
 */
export class AddCommunityJoinRequestReviewFields1793820000000 implements MigrationInterface {
  name = 'AddCommunityJoinRequestReviewFields1793820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_join_requests_involvement_enum" AS ENUM
        ('updates', 'active', 'organise')
    `);
    await queryRunner.query(`
      CREATE TYPE "community_join_requests_decline_kind_enum" AS ENUM
        ('not_now', 'not_a_fit')
    `);
    await queryRunner.query(`
      ALTER TABLE "community_join_requests"
        ADD "involvement" "community_join_requests_involvement_enum"
    `);
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" ADD "decline_reason" text`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_join_requests"
        ADD "decline_kind" "community_join_requests_decline_kind_enum"
    `);
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" ADD "reapply_after" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP COLUMN "reapply_after"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP COLUMN "decline_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP COLUMN "decline_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP COLUMN "involvement"`,
    );
    await queryRunner.query(
      `DROP TYPE "community_join_requests_decline_kind_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "community_join_requests_involvement_enum"`,
    );
  }
}
