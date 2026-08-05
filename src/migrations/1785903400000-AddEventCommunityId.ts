import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `events.community_id` — an optional link from an event to the
 * community it belongs to, so a community's page can show its own upcoming
 * events (part of "Personalized Community Pulse"). Nullable: events aren't
 * required to be tied to a specific community.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddEventCommunityId1785903400000 implements MigrationInterface {
  name = 'AddEventCommunityId1785903400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" ADD "community_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_events_community_id" ON "events" ("community_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_events_community_id"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN "community_id"`);
  }
}
