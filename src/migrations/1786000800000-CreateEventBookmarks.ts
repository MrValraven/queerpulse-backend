import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `event_bookmarks` — one row per member "saving"/bookmarking an event.
 * Backs `GET /events?filter=saved` (previously an honest empty stub, see
 * `EventsService.list`) and the `isBookmarked` flag on event summaries/detail.
 *
 * `UQ_event_bookmarks (user_id, event_id)` makes bookmarking idempotent at the
 * DB level and doubles as the leading index for the "which of these events has
 * this user bookmarked?" batch lookup; `IDX_event_bookmarks_event_id` supports
 * the event-side join / cascade. Both FKs cascade on delete, matching the
 * events family (`event_cohosts` / `event_rsvps` / `event_invites`).
 */
export class CreateEventBookmarks1786000800000 implements MigrationInterface {
  name = 'CreateEventBookmarks1786000800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "event_bookmarks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_bookmarks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_bookmarks" UNIQUE ("user_id", "event_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_bookmarks_event_id" ON "event_bookmarks" ("event_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_bookmarks" ADD CONSTRAINT "FK_event_bookmarks_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_bookmarks" ADD CONSTRAINT "FK_event_bookmarks_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_bookmarks" DROP CONSTRAINT "FK_event_bookmarks_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_bookmarks" DROP CONSTRAINT "FK_event_bookmarks_event_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_event_bookmarks_event_id"`);
    await queryRunner.query(`DROP TABLE "event_bookmarks"`);
  }
}
