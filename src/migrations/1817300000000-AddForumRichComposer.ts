// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The schema half of the richer forum composer: ten new `forum_thread`
 * columns, the keyset indexes the new read gate needs, and four new child
 * tables (`forum_poll`, `forum_poll_option`, `forum_poll_vote`,
 * `forum_post_photo`). SCHEMA ONLY — no service, controller, DTO or response
 * mapper is touched here; the write/read paths that fill these columns land
 * separately.
 *
 * ## The new `forum_thread` columns
 *
 * `kind` (varchar(16), NULL) — what the thread IS: `question`, `guide`,
 * `proposal`, `share`. The forum already carries all four shapes under one
 * undifferentiated "thread", which is why `unanswered` had to be rescued once
 * already (`AddForumThreadAcceptedPost1794711000000`): a guide has no answer to
 * accept and a proposal's resolution is a decision, not a reply. NULLABLE
 * rather than defaulted, because every thread written before this migration was
 * written without the question being asked, and stamping them all `question`
 * would be a guess printed on the card as a fact. NULL reads as "unclassified"
 * and the composer only offers the four values going forward. varchar over a
 * Postgres enum deliberately: this vocabulary is expected to grow (a fifth kind
 * is a product decision, not a migration), and every other recent vocabulary
 * column in the forum (`category`, `tags`) is varchar/text for the same reason.
 *
 * `content_warnings` (text[] NOT NULL DEFAULT '{}') — the labels an author puts
 * in front of their own post so a reader can decide before reading, chosen from
 * a fixed list the composer offers (the list is application-side, same contract
 * as `tags`). Array rather than a join table: it is a handful of short labels
 * read on every render of the thread and never queried across threads, exactly
 * the shape `forum_thread.tags` already has. NOT NULL with a `'{}'` default so
 * "no warnings" is an empty array everywhere and no read path has to branch on
 * NULL — the same contract `tags` holds. No GIN index, unlike `tags`: nothing
 * filters or browses BY a content warning, they are rendered off an
 * already-fetched row. Add one with the first query that needs it.
 *
 * `is_anonymous` (boolean NOT NULL DEFAULT false) — masks the BYLINE only.
 * `author_id` stays the real member, untouched, so ownership, `canEdit`,
 * moderation, reports and the XP/recognition signals all keep working against a
 * real account. This is the same split `is_official` already uses (see the
 * `isOfficial` comment on `ForumThread`, where the admin poster stays in
 * `author_id` while the card renders "QueerPulse Official"), and it matters
 * more here: an anonymous thread is exactly the kind that draws a report, and a
 * report that cannot reach an actor is not actionable. Anonymity is a rendering
 * decision, never a gap in the record.
 *
 * `co_author_id` (uuid NULL, FK -> users ON DELETE SET NULL) — a second member
 * credited on the thread, for the guides and proposals two people actually
 * wrote together. `ON DELETE SET NULL`, not CASCADE: a co-author erasing their
 * account must not take somebody else's thread down with it, so the credit is
 * dropped and the thread stands. That SET NULL is also why
 * `IDX_forum_thread_co_author_id` exists — a `SET NULL` action has to find
 * every referencing row when the user row goes, and unindexed it scans the
 * whole thread table per deleted account (the same argument
 * `IDX_event_photos_uploader_id` is documented with). No relation decorator on
 * the entity: the forum module declares bare `uuid` columns and lets the
 * migration own the FK.
 *
 * `published_at` (timestamptz(3) NOT NULL, BACKFILLED) — when the thread became
 * visible, which stops being "when it was created" the moment the composer can
 * schedule. BACKFILLED to `created_at` for every existing row in this same
 * migration and only then set NOT NULL, because the alternative — a nullable
 * column — pushes a NULL check into every browse predicate forever and makes
 * the new read gate three-valued. For every thread written before scheduling
 * existed, "published" and "created" are the same instant, so the backfill is a
 * statement of fact, not a guess. The ADD COLUMN, the backfill and the SET NOT
 * NULL run in ONE transaction holding ACCESS EXCLUSIVE on `forum_thread`, so no
 * concurrent insert can slip a NULL row in between them. NO DEFAULT on the
 * finished column, deliberately: a `DEFAULT now()` would silently publish a
 * scheduled thread the moment an insert forgot to name the column, and the one
 * value this column must never invent is "now". Millisecond precision matches
 * `last_activity_at`/`created_at` on this table, so a future keyset on it does
 * not need a non-indexable `date_trunc()` wrapper (see
 * `1785001400000-NarrowCursorCreatedAtPrecision.ts`).
 *
 * `review_state` (varchar(12), NULL) — `pending` / `approved` / `rejected`,
 * where NULL means NEVER SUBMITTED FOR REVIEW and is therefore the state of
 * every thread that exists today. This is the load-bearing distinction: the
 * forum is not becoming a moderated-by-default surface, so NULL has to read as
 * "visible, nobody asked for review" and not as "unreviewed, therefore hidden".
 * Only the kinds that opt in (a guide going to the editors, a proposal going to
 * the council) ever leave NULL. No backfill, and none is possible — there is no
 * true value to write for a thread nobody ever reviewed.
 *
 * `cross_posted` (boolean NOT NULL DEFAULT false) — a thread that belongs to a
 * community (`community_id IS NOT NULL`) and ALSO shows in the town square.
 * Stored as its own flag rather than inferred, because "which community wrote
 * it" and "who gets to see it" are different questions: the flag is the
 * author's choice to carry their community's thread out to everyone, and a
 * community thread without it stays where it was written. False for every
 * existing row, which is the behaviour they have today.
 *
 * `neighbourhood` (varchar(60), NULL) — the part of the city a thread is about,
 * for the asks that only make sense locally. Free text at 60 characters rather
 * than a lookup table: neighbourhood names are contested, overlapping and
 * member-defined, and a curated list beside a taxonomy nobody owns drifts. No
 * index — nothing browses by it yet.
 *
 * `closes_at` (timestamptz(3), NULL) — after this instant the thread takes no
 * new replies. Distinct from `is_locked`/`lock_reason`, which is a MODERATOR
 * shutting a thread; this is the AUTHOR saying up front how long the question
 * is open (a poll that ends, a call for volunteers with a deadline). Enforced
 * by the reply path at write time, not by a job: a timestamp compared on write
 * cannot drift, cannot fire twice and needs nothing scheduled. NULL means the
 * thread never auto-closes, which is every thread that exists today.
 *
 * `language` (varchar(4), NULL) — `pt`, `en` or `both`. The forum is read by
 * people who have exactly one of the two, and a Portuguese-only thread at the
 * top of an English reader's list is a dead row for them. NULL is "unstated",
 * which is honest for the backlog: guessing from the text would mislabel every
 * short or mixed post. varchar(4) because `both` is the longest value and this
 * is a closed three-value vocabulary, not a locale tag.
 *
 * ## The indexes: what the new read gate costs
 *
 * Every member-facing browse gains two predicates on top of the
 * `deleted_at IS NULL` it already carries (`ForumThreadsService
 * .excludeDeletedThreads`):
 *
 *     published_at <= now()
 *     AND (review_state IS NULL OR review_state = 'approved')
 *
 * The two migration-owned partial keyset indexes on this table are partial on
 * predicates the gate now strictly extends, so as written they cover rows the
 * gated sorts can no longer return. Both are therefore SUPERSEDED here by a
 * version carrying the gate — the same supersede-and-drop
 * `AddForumThreadTopKeysetAndReplySearch1801010000000` performed on
 * `IDX_forum_thread_op_vote_count_id`, and for the same reason: left in place
 * they would cost every insert, every reply and every OP vote, forever, to
 * serve a query shape that no longer exists.
 *
 * 1. `IDX_forum_thread_visible_top_keyset`
 *    (`op_vote_count DESC, last_activity_at DESC, id DESC`,
 *    `WHERE deleted_at IS NULL AND (review_state IS NULL OR review_state =
 *    'approved')`) replaces `IDX_forum_thread_top_keyset`. Same three key
 *    columns in the same directions, matching `ForumThreadsService
 *    .paginateTop`'s ORDER BY verbatim (a direction mismatch makes the index
 *    unusable for the seek); only the predicate narrows.
 *
 * 2. `IDX_forum_thread_visible_unanswered_created_at_id`
 *    (`created_at DESC, id DESC`, `WHERE accepted_post_id IS NULL AND
 *    deleted_at IS NULL AND (review_state IS NULL OR review_state =
 *    'approved')`) replaces `IDX_forum_thread_unanswered_created_at_id`. The
 *    old predicate was `accepted_post_id IS NULL` alone; the `unanswered` sort
 *    has carried `deleted_at IS NULL` since PRD-160 and now carries the gate
 *    too, so the replacement folds in both and covers exactly the rows that
 *    sort can return.
 *
 * WHY THE REVIEW ARM IS IN THE PREDICATE AND `published_at` IS NOT. Postgres
 * rejects `now()` in an index predicate outright — predicate expressions must
 * be IMMUTABLE and `now()` is STABLE — so `published_at <= now()` CANNOT be
 * indexed this way at all, by anyone, ever. It is left as a filter on the
 * already-seeked rows, which is cheap for the right reason rather than by luck:
 * the rows it removes are the scheduled-future ones, a small tail that clusters
 * at the newest end of both sorts. The review arm has no such problem
 * (`IS NULL` and a constant equality are both immutable) and IS worth
 * indexing, because a rejected or pending thread is otherwise a live row the
 * seek has to walk past on a surface it will never appear on. The read path
 * must emit that disjunction VERBATIM, arm for arm — Postgres's predicate
 * prover matches an OR in an index predicate against an OR in the query by
 * proving each query arm implies some predicate arm, so a rewrite such as
 * `review_state IS DISTINCT FROM 'pending'` silently loses the index.
 *
 * NOT TOUCHED, deliberately: `IDX_forum_thread_created_at_id` (the `new` sort)
 * and `IDX_forum_thread_last_activity_id` (the `active` sort) stay whole. Both
 * are declared by `@Index` decorators on the entity, so a migration narrowing
 * them here would be undone by the next `migration:generate` diff; and the
 * entity's own `deleted_at` comment already records the decision to leave them
 * whole absent a measurement saying the extra filter step costs something. The
 * gate does not change that argument.
 *
 * ALSO NOT ADDED: no index on `review_state = 'pending'`. A staff review queue
 * would want one, but no such read path exists yet and a speculative index is
 * write cost paid against a query nobody has written. It belongs in the
 * migration that ships the queue, sized against the queue's real ORDER BY.
 * Likewise no index on `published_at`, `kind`, `language`, `neighbourhood`,
 * `cross_posted` or `content_warnings`: all six are rendered off an
 * already-fetched row, and `published_at <= now()` is true for effectively
 * every row, so an index on it would never be chosen.
 *
 * ## The poll tables
 *
 * One poll per thread, enforced in the schema by a UNIQUE on
 * `forum_poll.thread_id` rather than by a service check — a second poll on a
 * thread is not a state the read path can render, so the database is the right
 * place to make it impossible. `ON DELETE CASCADE` down the whole chain
 * (thread -> poll -> option -> vote): a poll has no meaning without its thread,
 * an option none without its poll, and a vote none without its option.
 *
 * `forum_poll_vote` is modelled on `forum_post_vote`, with ONE deliberate
 * difference in the unique key. `forum_post_vote` is unique on
 * `(post_id, user_id)` because a post takes one vote per member. A poll's
 * unique is `(option_id, user_id)` — one vote per member per OPTION — and that
 * is precisely what makes `allow_multiple` work: a multi-choice poll is a
 * member holding several rows, one per option they picked, each one
 * individually idempotent. A single-choice poll is the same table with the
 * service allowing exactly one row; the constraint does not need to know which
 * mode the poll is in. `poll_id` is carried on the vote row as a denormalized
 * copy of `option.poll_id` (and indexed) so counting or clearing a member's
 * votes for a poll is one indexed lookup rather than a join through every
 * option.
 *
 * `vote_count` on `forum_poll_option` is the same denormalization
 * `forum_post.vote_count` and `forum_thread.op_vote_count` already use: the
 * result bars render on every poll view and must not cost a `COUNT(*)` per
 * option.
 *
 * `position` (smallint) on options is the author's ordering, unique per poll
 * so two options cannot claim the same slot and leave the render tie-broken on
 * a uuid. That `UQ_forum_poll_option_poll_position` index leads with `poll_id`,
 * so it also serves every poll-scoped option lookup and the cascade's own
 * referencing-row search — a separate `poll_id` index would be a second copy of
 * the same leading column, paid for on every write and chosen by nothing.
 *
 * ## `forum_post_photo`
 *
 * Modelled on `event_photos` (`src/events/entities/event-photo.entity.ts`):
 * a bare `storage_key` (never a URL) with a GLOBAL unique constraint, so one
 * uploaded object is attached to at most one post, plus `position` for the
 * author's ordering, unique per post for the same reason the poll options are.
 * `UQ_forum_post_photo_post_position` leads with `post_id` and therefore serves
 * the post-scoped fetch and the cascade search, so no separate `post_id` index
 * is created. `alt` is varchar(280) and nullable — alt text is written by a
 * person, often later, and a placeholder auto-filled to satisfy NOT NULL is
 * worse for a screen reader than no alt at all.
 *
 * `forum_post.image` IS LEFT EXACTLY AS IT IS. This table is purely ADDITIVE:
 * the existing single-image column keeps every already-published post's photo
 * where it is, unmoved and unread by this migration, and stays the first
 * photo's home for those posts. Nothing is backfilled out of it into
 * `forum_post_photo` and nothing here drops or rewrites it. A backfill would
 * have to be paired, atomically, with a read path that prefers the child table
 * — and that read path is owned by another change — so moving the data now
 * would risk a window where a post's only photo is in a table nothing reads.
 *
 * ## Transactionality
 *
 * TRANSACTIONAL. Every statement here is ordinary DDL plus one bounded backfill
 * UPDATE, and they must land together: `published_at` NOT NULL is only true
 * because the backfill ran, and the two superseded indexes must not disappear
 * unless their replacements commit. The index rebuilds are plain, blocking
 * `CREATE INDEX`, NOT `CONCURRENTLY` — Postgres forbids `CONCURRENTLY` inside a
 * transaction block, and it would buy nothing here anyway: the `published_at`
 * backfill already takes ACCESS EXCLUSIVE on `forum_thread` and rewrites every
 * row, so this migration needs a maintenance window regardless and every object
 * is built inside that one window. Same call, same reasoning, as
 * `AddForumThreadAcceptedPost1794711000000`. If `forum_thread` ever grows past
 * what that window tolerates, split the two index rebuilds into their own
 * non-transactional migration rather than mixing modes in this file.
 *
 * No `IF [NOT] EXISTS` guards anywhere: re-runnability comes from the deploy
 * preflight, not from guards that would hide drift (see CLAUDE.md).
 */
export class AddForumRichComposer1817300000000 implements MigrationInterface {
  name = 'AddForumRichComposer1817300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `published_at` is added NULLable here and tightened below, after the
    // backfill. The whole migration runs in one transaction holding ACCESS
    // EXCLUSIVE on the table, so no insert can land a NULL row in between.
    await queryRunner.query(`
      ALTER TABLE "forum_thread"
        ADD COLUMN "kind" character varying(16) NULL,
        ADD COLUMN "content_warnings" text[] NOT NULL DEFAULT '{}',
        ADD COLUMN "is_anonymous" boolean NOT NULL DEFAULT false,
        ADD COLUMN "co_author_id" uuid NULL,
        ADD COLUMN "published_at" TIMESTAMP(3) WITH TIME ZONE NULL,
        ADD COLUMN "review_state" character varying(12) NULL,
        ADD COLUMN "cross_posted" boolean NOT NULL DEFAULT false,
        ADD COLUMN "neighbourhood" character varying(60) NULL,
        ADD COLUMN "closes_at" TIMESTAMP(3) WITH TIME ZONE NULL,
        ADD COLUMN "language" character varying(4) NULL
    `);

    // Backfill: for every thread written before scheduling existed, published
    // and created are the same instant. Unconditional — the column was added
    // NULL for all rows two statements ago.
    await queryRunner.query(`
      UPDATE "forum_thread" SET "published_at" = "created_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "forum_thread" ALTER COLUMN "published_at" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "forum_thread" ADD CONSTRAINT "FK_forum_thread_co_author_id"
        FOREIGN KEY ("co_author_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    // Backs the SET NULL above: without it, erasing one account scans the whole
    // thread table looking for rows to clear.
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_co_author_id"
        ON "forum_thread" ("co_author_id")
    `);

    // Replacements are built BEFORE the indexes they supersede are dropped, so
    // no window exists in which a sort has neither available.
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_visible_top_keyset"
        ON "forum_thread" ("op_vote_count" DESC, "last_activity_at" DESC, "id" DESC)
        WHERE "deleted_at" IS NULL
          AND ("review_state" IS NULL OR "review_state" = 'approved')
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_visible_unanswered_created_at_id"
        ON "forum_thread" ("created_at" DESC, "id" DESC)
        WHERE "accepted_post_id" IS NULL
          AND "deleted_at" IS NULL
          AND ("review_state" IS NULL OR "review_state" = 'approved')
    `);
    await queryRunner.query(`DROP INDEX "IDX_forum_thread_top_keyset"`);
    await queryRunner.query(
      `DROP INDEX "IDX_forum_thread_unanswered_created_at_id"`,
    );

    // One poll per thread — the UNIQUE on thread_id is the enforcement.
    await queryRunner.query(`
      CREATE TABLE "forum_poll" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "thread_id" uuid NOT NULL,
        "allow_multiple" boolean NOT NULL DEFAULT false,
        "closes_at" TIMESTAMP(3) WITH TIME ZONE NULL,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forum_poll" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forum_poll_thread_id" UNIQUE ("thread_id"),
        CONSTRAINT "FK_forum_poll_thread_id" FOREIGN KEY ("thread_id")
          REFERENCES "forum_thread"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    // `UQ_forum_poll_option_poll_position` leads with poll_id, so it also
    // serves poll-scoped option reads and the cascade's referencing-row search;
    // a separate poll_id index would duplicate that leading column.
    await queryRunner.query(`
      CREATE TABLE "forum_poll_option" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "poll_id" uuid NOT NULL,
        "label" character varying(60) NOT NULL,
        "position" smallint NOT NULL,
        "vote_count" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_forum_poll_option" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forum_poll_option_poll_position" UNIQUE ("poll_id", "position"),
        CONSTRAINT "FK_forum_poll_option_poll_id" FOREIGN KEY ("poll_id")
          REFERENCES "forum_poll"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    // Unique on (option_id, user_id), not (poll_id, user_id): one row per
    // option is what lets a multi-choice poll hold several rows for one member
    // while each single pick stays idempotent.
    await queryRunner.query(`
      CREATE TABLE "forum_poll_vote" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "poll_id" uuid NOT NULL,
        "option_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forum_poll_vote" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forum_poll_vote_option_user" UNIQUE ("option_id", "user_id"),
        CONSTRAINT "FK_forum_poll_vote_poll_id" FOREIGN KEY ("poll_id")
          REFERENCES "forum_poll"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_forum_poll_vote_option_id" FOREIGN KEY ("option_id")
          REFERENCES "forum_poll_option"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_forum_poll_vote_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_poll_vote_poll_id"
        ON "forum_poll_vote" ("poll_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_poll_vote_user_id"
        ON "forum_poll_vote" ("user_id")
    `);

    // `storage_key` is globally unique, as on `event_photos`: one uploaded
    // object belongs to at most one post. `UQ_forum_post_photo_post_position`
    // leads with post_id and serves the post-scoped read and the cascade.
    await queryRunner.query(`
      CREATE TABLE "forum_post_photo" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "storage_key" text NOT NULL,
        "alt" character varying(280) NULL,
        "position" smallint NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forum_post_photo" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forum_post_photo_storage_key" UNIQUE ("storage_key"),
        CONSTRAINT "UQ_forum_post_photo_post_position" UNIQUE ("post_id", "position"),
        CONSTRAINT "FK_forum_post_photo_post_id" FOREIGN KEY ("post_id")
          REFERENCES "forum_post"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "forum_post_photo"`);

    await queryRunner.query(`DROP INDEX "IDX_forum_poll_vote_user_id"`);
    await queryRunner.query(`DROP INDEX "IDX_forum_poll_vote_poll_id"`);
    await queryRunner.query(`DROP TABLE "forum_poll_vote"`);
    await queryRunner.query(`DROP TABLE "forum_poll_option"`);
    await queryRunner.query(`DROP TABLE "forum_poll"`);

    // Rebuilt first, mirroring `up()`'s build-before-drop rule in reverse.
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_unanswered_created_at_id"
        ON "forum_thread" ("created_at" DESC, "id" DESC)
        WHERE "accepted_post_id" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_top_keyset"
        ON "forum_thread" ("op_vote_count" DESC, "last_activity_at" DESC, "id" DESC)
        WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(
      `DROP INDEX "IDX_forum_thread_visible_unanswered_created_at_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_forum_thread_visible_top_keyset"`);

    await queryRunner.query(`DROP INDEX "IDX_forum_thread_co_author_id"`);
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP CONSTRAINT "FK_forum_thread_co_author_id"`,
    );

    await queryRunner.query(`
      ALTER TABLE "forum_thread"
        DROP COLUMN "language",
        DROP COLUMN "closes_at",
        DROP COLUMN "neighbourhood",
        DROP COLUMN "cross_posted",
        DROP COLUMN "review_state",
        DROP COLUMN "published_at",
        DROP COLUMN "co_author_id",
        DROP COLUMN "is_anonymous",
        DROP COLUMN "content_warnings",
        DROP COLUMN "kind"
    `);
  }
}
