// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Landing visit counts: one row per (UTC calendar day, normalized source)
 * holding how many visits the public landing page received from that source
 * on that day.
 *
 * The table holds only the day, the source label and a count. It carries no
 * IP, no user agent, no cookie, no member id and no time of day, so there is
 * no data subject in it, the same property as `feature_usage_daily`.
 *
 * The composite primary key is the upsert target and also serves the admin
 * range read (`day >= $1`), so no further index is needed.
 */
export class AddLandingVisitDaily1837400000000 implements MigrationInterface {
  name = 'AddLandingVisitDaily1837400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "landing_visit_daily" (
        "day" date NOT NULL,
        "source" varchar(64) NOT NULL,
        "visits" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_landing_visit_daily" PRIMARY KEY ("day", "source")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "landing_visit_daily"`);
  }
}
