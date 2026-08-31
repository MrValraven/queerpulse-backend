import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A denormalised activity counter on `communities`: `active_this_week` (how
 * many distinct members posted or replied over the trailing week) and
 * `activity_counted_at` (when that number was last recomputed).
 *
 * This exists so discover can SORT and FILTER by liveliness in SQL. Today the
 * frontend drains every page of the community list and computes the same
 * number client-side, which cannot be paginated, cannot be used in a `WHERE`
 * clause, and gets slower with every community added.
 *
 * It is refreshed on a schedule, so treat it as approximate by design: a read
 * gets the last counted value, and `activity_counted_at` is exactly how stale
 * that value is allowed to be. NULL there means never counted, which readers
 * should present as unknown rather than as zero activity.
 *
 * `active_this_week` is NOT NULL default 0, so a community the refresh has not
 * reached yet sorts as quiet instead of dropping out of a filtered query.
 * `IDX_communities_active_this_week` backs the discover sort. Plain
 * `CREATE INDEX` (no `CONCURRENTLY`): the column is constant-defaulted and
 * every row holds the same 0 at this point, so the build is cheap and the file
 * stays transactional.
 */
export class AddCommunityActivityCounter1793880000000 implements MigrationInterface {
  name = 'AddCommunityActivityCounter1793880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "active_this_week" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "activity_counted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_communities_active_this_week" ON "communities" ("active_this_week")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_communities_active_this_week"`);
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "activity_counted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "active_this_week"`,
    );
  }
}
