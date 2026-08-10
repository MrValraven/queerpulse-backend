import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `event_lineup_entries` — a host-tagged "who performed" credit on an
 * event, one row per (event, member). Backs `PUT/GET /events/:slug/lineup`
 * (Personas Phase 5, Moment 5: the post-gathering persona nudge — a member
 * on the bill for an ended gathering, without a persona matching their
 * lineup role, gets nudged to start one pre-linked to the gathering).
 *
 * `UQ_event_lineup_entries (event_id, user_id)` makes a host's "replace the
 * whole lineup" write idempotent per member (delete-then-insert inside one
 * transaction — see `EventsService.replaceLineup`); `IDX_event_lineup_
 * entries_event_id` supports the event-side join / cascade, mirroring
 * `event_cohosts` / `event_bookmarks`. Both FKs cascade on delete, matching
 * the rest of the events family.
 *
 * Additive only. DO NOT RUN — authored for review only; the maintainer runs
 * migrations.
 */
export class AddEventLineup1786800000000 implements MigrationInterface {
  name = 'AddEventLineup1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "event_lineup_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" character varying(40) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_lineup_entries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_lineup_entries" UNIQUE ("event_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_lineup_entries_event_id" ON "event_lineup_entries" ("event_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" ADD CONSTRAINT "FK_event_lineup_entries_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" ADD CONSTRAINT "FK_event_lineup_entries_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" DROP CONSTRAINT "FK_event_lineup_entries_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_lineup_entries" DROP CONSTRAINT "FK_event_lineup_entries_event_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_event_lineup_entries_event_id"`);
    await queryRunner.query(`DROP TABLE "event_lineup_entries"`);
  }
}
