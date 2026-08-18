import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `volunteer_opportunities.community_id` — an optional link from an
 * opportunity to the member community it belongs to, alongside the existing
 * `partner_id` link to the (separate) partner-org directory. A poster picks
 * one or the other from a single combined "organization" control on the
 * frontend; the two columns stay structurally independent on the backend,
 * mirroring `partner_id`'s nullable/indexed/no-FK shape (see
 * `AddVolunteering1782693500000`).
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddVolunteerOpportunityCommunityId1789800000000 implements MigrationInterface {
  name = 'AddVolunteerOpportunityCommunityId1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunities" ADD "community_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_opportunities_community_id" ON "volunteer_opportunities" ("community_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_volunteer_opportunities_community_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunities" DROP COLUMN "community_id"`,
    );
  }
}
