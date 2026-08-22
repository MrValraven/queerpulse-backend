import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-member, REVOCABLE calendar-feed tokens (BE-MSG-11).
 *
 * Replaces the previous derived token `"<userId>.<HMAC_JWT_ACCESS_SECRET(userId)>"`,
 * which had three problems a stored token fixes:
 *
 *  - **Non-revocable.** It was a pure function of the user id and one
 *    platform-wide secret, so a leaked feed URL stayed valid forever and the
 *    only way to invalidate it was rotating `JWT_ACCESS_SECRET` — logging every
 *    member out of the whole platform.
 *  - **It disclosed the member's internal uuid** to Google/Apple Calendar and
 *    to anyone the URL was pasted in front of.
 *  - **It reused the access-token secret** for a credential with a completely
 *    different lifetime and blast radius.
 *
 * The replacement is 32 random bytes, unique per member, stored here and
 * matched by exact lookup. `DELETE /me/calendar-feed-token` drops the row, so
 * revoking one leaked calendar URL is a per-member action with no side effects
 * on anyone else; the next `GET /me/calendar-feed-token` mints a fresh one.
 *
 * The token is stored in the CLEAR rather than hashed, deliberately. The
 * subscribe affordance re-displays the same URL every time the member opens it
 * (`CalendarSubscribe`), so the value has to remain readable — the
 * hash-at-rest pattern only works for a show-once secret. The exposure it would
 * have bought is also close to nil here: the token grants read access to the
 * member's own RSVP rows, which live in this same database, so anyone who can
 * read this table can already read the data the token unlocks.
 *
 * `user_id` carries an `ON DELETE CASCADE` FK — unlike the snapshot-identity
 * columns elsewhere in this schema, this is not a historical reference but a
 * LIVE credential, and a deleted account must not leave a working feed URL
 * behind. The unique index on it is what makes the row a per-member singleton
 * (mint is an upsert on that key).
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCalendarFeedTokens1793510000000 implements MigrationInterface {
  name = 'AddCalendarFeedTokens1793510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "calendar_feed_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "token" character varying(64) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_calendar_feed_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_calendar_feed_tokens_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    // One live token per member: the mint path upserts on this key, so asking
    // for the subscribe URL twice returns the SAME token instead of silently
    // breaking the calendar the member already subscribed.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_calendar_feed_tokens_user" ON "calendar_feed_tokens" ("user_id")`,
    );
    // Verification is an exact lookup on this column for every feed poll.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_calendar_feed_tokens_token" ON "calendar_feed_tokens" ("token")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "calendar_feed_tokens"`);
  }
}
