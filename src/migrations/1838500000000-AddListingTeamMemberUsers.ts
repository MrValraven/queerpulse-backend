// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Meet the team, members: a `listing_team_members` row can now point at a
 * member (`user_id`) instead of a persona (`subprofile_id`). Exactly one of
 * the two is set, a member row is always started by the listing, and one live
 * row (pending or accepted) exists per listing and member pair.
 *
 * The persona unique index and the `ON CONFLICT (listing_id, subprofile_id)`
 * upserts keep working: NULL subprofile ids are distinct, so member rows never
 * collide with them. Every existing row has a subprofile id and no user id, so
 * the new checks validate against current data. The table is small, so the new
 * column, constraints and indexes build inside the transaction.
 */
export class AddListingTeamMemberUsers1838500000000 implements MigrationInterface {
  name = 'AddListingTeamMemberUsers1838500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" ALTER COLUMN "subprofile_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" ADD COLUMN "user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" ADD CONSTRAINT "FK_listing_team_members_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" ADD CONSTRAINT "CHK_listing_team_members_one_subject" CHECK ((("subprofile_id" IS NOT NULL)::int + ("user_id" IS NOT NULL)::int) = 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" ADD CONSTRAINT "CHK_listing_team_members_member_listing_initiated" CHECK ("user_id" IS NULL OR "initiated_by" = 'listing')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_listing_team_members_live_member" ON "listing_team_members" ("listing_id", "user_id") WHERE "status" IN ('pending', 'accepted')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_team_members_user_status" ON "listing_team_members" ("user_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Member rows have no subprofile id, so they cannot survive the NOT NULL
    // restore. They are removed first; this loses every member link.
    await queryRunner.query(
      `DELETE FROM "listing_team_members" WHERE "user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_listing_team_members_user_status"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_listing_team_members_live_member"`);
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" DROP CONSTRAINT "CHK_listing_team_members_member_listing_initiated"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" DROP CONSTRAINT "CHK_listing_team_members_one_subject"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" DROP CONSTRAINT "FK_listing_team_members_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" DROP COLUMN "user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_team_members" ALTER COLUMN "subprofile_id" SET NOT NULL`,
    );
  }
}
