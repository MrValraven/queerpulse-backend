// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two new event tables, plus the indexes the LOC-17 discovery filters
 * need. Runs after `AddEventLocationAccessCostAndCheckIn1794700000000`, which
 * creates the `events.neighbourhood` / `events.event_type` columns the two
 * discovery indexes are built on.
 *
 * ── `event_announcements` (LOC-06) ─────────────────────────────────────────
 * "Message attendees" was a modal whose send handler set a local boolean and
 * drew a panel saying it had gone to N people. There was no request behind it,
 * so a live host had no way to say "we moved to the back room" or "here is the
 * door code".
 *
 * The row exists rather than the notification alone because a notification is
 * a moment and the moment passes: a member who reads the door code on the tram
 * needs to find it again at the door, and a host part-way through the evening
 * needs to know what they already said. `recipient_count` is stamped at send
 * time so the host's sent list can say "went to 14 people" without recomputing
 * a roster that has since changed.
 *
 * `author_id` is `ON DELETE SET NULL` for exactly the reason `events.host_id`
 * is (`SetNullContentAuthorFksOnUserErasure1794610000000`): erasing the host's
 * account must not delete the announcement everybody planned their evening
 * around. NULL reads as "a former organiser". `event_id` is `CASCADE` — an
 * announcement about a gathering that no longer exists is nothing.
 *
 * DELIVERY IS IN-APP PLUS PUSH. QueerPulse sends no email and never will.
 *
 * ── `event_bans` (LOC-08) ──────────────────────────────────────────────────
 * A host afraid of one person had two tools: remove them (and watch them RSVP
 * again a second later) or cancel the whole gathering. A ban is checked inside
 * `RsvpService.assertMayRsvp`, the same guard the audience tiers go through,
 * so it holds on every write path onto the roster.
 *
 * `UQ_event_bans` keeps it singular per (event, member), so barring twice is a
 * no-op rather than a stack of rows. `banned_by_user_id` is `SET NULL` so an
 * erased organiser's account does not quietly reopen the door; `user_id` and
 * `event_id` are `CASCADE`, because a bar on a deleted account or a deleted
 * gathering is meaningless.
 *
 * `reason` is the organiser's own note. Nothing reads it but the organiser-only
 * ban list, and no notification carries it: a host has to be able to write down
 * why without it becoming a message to the person it is about.
 *
 * ── Discovery indexes (LOC-17) ─────────────────────────────────────────────
 * `GET /events` accepted `filter`, `page`, `hostSlug` and `excludeSlug` and
 * nothing else, so the browse search box and its chips filtered CLIENT-side
 * over whatever pages had loaded and under-reported every answer until the
 * member had scrolled the whole feed. The new `hood`/`type` predicates are
 * `lower(column) = lower(:value)`, so the indexes are on `lower(...)` to match:
 * a plain btree on the raw column would not be used by that predicate at all.
 * Both are partial on published events, because that is the only status the
 * browse feed reads.
 *
 * `from`/`to` need no new index: they narrow `start_at` alongside the
 * `status = 'published'` predicate the existing composite
 * `IDX_events_status_start_at (status, start_at)` already covers. `q` reuses
 * the trigram indexes `AddSearchTrgmAndTagsIndexes1785700100000` built on
 * `title`/`venue`/`description`; the extra `neighbourhood` ILIKE term rides
 * along on the hood index's own selectivity and is not worth a fourth GIN.
 * `cost` gets no index deliberately: it is a low-cardinality predicate always
 * applied after the date/status ones, and indexing it would cost more on write
 * than it saves on read.
 *
 * NO `CONCURRENTLY`. The two tables are created empty in this same migration,
 * and the two `events` indexes are partial over a table whose live row count is
 * in the low thousands, so a plain transactional `CREATE INDEX` is a moment's
 * write lock rather than the two-phase runbook a large table would need.
 */
export class CreateEventAnnouncementsAndBans1794701000000 implements MigrationInterface {
  name = 'CreateEventAnnouncementsAndBans1794701000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "event_announcements" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "author_id" uuid,
        "body" text NOT NULL,
        "recipient_count" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_announcements" PRIMARY KEY ("id"),
        CONSTRAINT "FK_event_announcements_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_announcements_author" FOREIGN KEY ("author_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    // The only read there is: one event's announcements, newest first.
    await queryRunner.query(`
      CREATE INDEX "IDX_event_announcements_event_id_created_at"
        ON "event_announcements" ("event_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "event_bans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "banned_by_user_id" uuid,
        "reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_bans" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_bans" UNIQUE ("event_id", "user_id"),
        CONSTRAINT "FK_event_bans_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_bans_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_bans_banned_by" FOREIGN KEY ("banned_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_event_bans_event_id" ON "event_bans" ("event_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_event_bans_user_id" ON "event_bans" ("user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_events_neighbourhood"
        ON "events" (lower("neighbourhood"))
        WHERE "status" = 'published'
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_events_event_type"
        ON "events" (lower("event_type"))
        WHERE "status" = 'published'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_events_event_type"`);
    await queryRunner.query(`DROP INDEX "IDX_events_neighbourhood"`);
    await queryRunner.query(`DROP TABLE "event_bans"`);
    await queryRunner.query(`DROP TABLE "event_announcements"`);
  }
}
