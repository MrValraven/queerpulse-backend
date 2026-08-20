import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MSG-10 — recurring gatherings. Adds `event_series` (one row per repeat
 * rule: cadence + end condition) and links `events` to it via nullable
 * `series_id`/`series_index`. Deliberately NOT an RFC5545/RRULE engine and
 * NOT a lazy generation job: `EventsService.create` generates every
 * occurrence as its own real, independent `Event` row up front (capped at
 * `MAX_OCCURRENCES` = 52), so `event_series` is read-only history after
 * create — no cron/worker touches it. See `EventSeries`'s class doc.
 *
 * `series_id` uses `ON DELETE SET NULL` (not `CASCADE`): the app never
 * deletes an `event_series` row, but if it ever did, that must not cascade
 * into deleting real, independently-RSVPable `Event` rows — it should just
 * orphan them back to standalone events.
 *
 * DO NOT RUN. Authored for review only; the maintainer runs migrations.
 */
export class AddEventRecurrence1792800000000 implements MigrationInterface {
  name = 'AddEventRecurrence1792800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "event_series_cadence_enum" AS ENUM('weekly', 'biweekly', 'monthly')`,
    );
    await queryRunner.query(
      `CREATE TYPE "event_series_end_type_enum" AS ENUM('count', 'date')`,
    );
    await queryRunner.query(`
      CREATE TABLE "event_series" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "host_id" uuid NOT NULL,
        "cadence" "event_series_cadence_enum" NOT NULL,
        "end_type" "event_series_end_type_enum" NOT NULL,
        "end_count" integer,
        "end_until" TIMESTAMP WITH TIME ZONE,
        "occurrence_count" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_series" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_series_host_id" ON "event_series" ("host_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_series" ADD CONSTRAINT "FK_event_series_host_id" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "events" ADD "series_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ADD "series_index" integer`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_events_series_id" ON "events" ("series_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ADD CONSTRAINT "FK_events_series_id" FOREIGN KEY ("series_id") REFERENCES "event_series"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" DROP CONSTRAINT "FK_events_series_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_events_series_id"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN "series_index"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN "series_id"`);

    await queryRunner.query(
      `ALTER TABLE "event_series" DROP CONSTRAINT "FK_event_series_host_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_event_series_host_id"`);
    await queryRunner.query(`DROP TABLE "event_series"`);
    await queryRunner.query(`DROP TYPE "event_series_end_type_enum"`);
    await queryRunner.query(`DROP TYPE "event_series_cadence_enum"`);
  }
}
