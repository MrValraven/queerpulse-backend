/**
 * ENG-243: what happens to an erased member's messages, as SQL shared by the
 * erasure transaction (`AccountDeletionProcessorService`) and the daily release
 * sweep (`ErasedSenderMessageReleaseService`).
 *
 * Product decision, verbatim intent: "keep if open report, but everything else
 * should show up as 'message deleted'".
 *
 *  (a) HELD. In a conversation holding an OPEN or ESCALATED report tied to the
 *      member, their messages stay readable to the counterparts. `sender_id`
 *      goes NULL with the user row (the reader shows "Former member") and
 *      `erased_sender_ref` keeps the former id so the sweep can re-check the
 *      tie later.
 *  (b) TOMBSTONED. Every other message they sent is soft-deleted exactly like
 *      an author's own "delete for everyone": `deleted_at` set, body blanked,
 *      every other content-bearing field cleared. The slot stays, so the
 *      counterpart sees "Message deleted" where the line used to be.
 *  (c) RELEASED. Once no open or escalated tied report remains, the sweep
 *      tombstones held rows like (b) and clears `erased_sender_ref`.
 *
 * "Tied" means either
 *  - a `message` report on one of the member's messages in that conversation,
 *    or
 *  - a `member` report about them whose reporter is (or was) a participant of
 *    that conversation. A participant row survives leaving a group, so "was" is
 *    covered by the row existing at all.
 *
 * System pills are excluded from both (a) and (b): they are audit lines whose
 * `sender_id` is the event's actor, not something the member wrote.
 */

/** Report statuses that keep a conversation's messages held. */
export const HOLDING_REPORT_STATUS_SQL = `('open', 'escalated')`;

/** Rows per UPDATE in the keyset-paginated tombstone and release loops. */
export const ERASED_SENDER_MESSAGE_BATCH_SIZE = 1000;

/**
 * The SET list that turns a row into an ordinary tombstone, in the shape
 * `MessagesService.deleteMessage` leaves one plus the content scrub erasure
 * owes the member:
 *
 *  - `deleted_at` kept when already set (a message the member deleted
 *    themselves keeps its own timestamp);
 *  - `body` blanked, `reply_to_id` and `forwarded` cleared;
 *  - `attachment`: a GIF (a third-party URL, no bytes of ours) is dropped; an
 *    image or document KEEPS its storage key, because the attachment purge
 *    sweep reads it to delete the bytes, but loses its caption and, for a
 *    document, its original file name (blanked rather than removed, since
 *    `isDocumentAttachment` discriminates on the key being present);
 *  - `attachment_purge_after = now()` on an image or document, which queues
 *    the bytes for the hourly attachment purge sweep (column added by
 *    `1820510000000`, task T2);
 *  - `erased_sender_ref` cleared: a tombstone is never held.
 *
 * Postgres evaluates every right-hand side against the OLD row, so the CASE
 * arms read the original `attachment` and `kind`.
 */
export const ERASED_SENDER_TOMBSTONE_ASSIGNMENTS_SQL = `
  "deleted_at" = COALESCE("deleted_at", now()),
  "body" = '',
  "reply_to_id" = NULL,
  "forwarded" = false,
  "erased_sender_ref" = NULL,
  "attachment" = CASE
    WHEN "attachment" IS NULL OR "kind" NOT IN ('image', 'document') THEN NULL
    WHEN "attachment" ? 'fileName'
      THEN jsonb_set("attachment" - 'caption', '{fileName}', '""'::jsonb)
    ELSE "attachment" - 'caption'
  END,
  "attachment_purge_after" = CASE
    WHEN "attachment" IS NOT NULL AND "kind" IN ('image', 'document') THEN now()
    ELSE "attachment_purge_after"
  END
`;

/**
 * Inside the erasure transaction, BEFORE the user row is deleted: re-key
 * `member` reports that name the member by profile SLUG onto their user id.
 *
 * The report form in a conversation files `subjectId: reportSubjectId ?? slug`,
 * so both keys exist in the table. Once the profile is gone a slug resolves to
 * nothing (or, if the slug is ever claimed again, to somebody else), and the
 * release sweep can only match `erased_sender_ref::text`. Re-keying keeps the
 * tie evaluable and stops a reused slug inheriting the report.
 *
 * SKIPS an OPEN row that would collide, and the guard matches the unique index
 * KEY EXACTLY. `UQ_reports_open_reporter_subject` (migration `1785003000000`)
 * is `(reporter_id, subject_type, subject_id) WHERE status = 'open'`, and
 * `reason_code` is NOT part of it. An earlier version of this guard also
 * required the twin's `reason_code` to match, so two open member reports from
 * the same reporter about the same person under DIFFERENT reasons (one filed
 * by slug, one by user id) were not recognised as a collision: the re-key
 * raised 23505 inside the single erasure transaction, the whole erasure rolled
 * back, and `eraseDueAccounts` retried it forever, so the deletion never
 * completed. Any predicate narrower than the index key reopens that.
 *
 * A NULL `reporter_id` (an anonymous filing, or a reporter since erased) needs
 * no skip and correctly gets none: the index treats NULLs as distinct, so two
 * such rows never collide, and `"twin"."reporter_id" = "reports"."reporter_id"`
 * is NULL rather than true for them.
 *
 * WHAT HAPPENS TO A COLLIDING SLUG ROW: it keeps its slug `subject_id` and is
 * left alone. It is by definition a duplicate of the twin (same reporter, same
 * person, both open), and the twin is already keyed to the user id, so the tie
 * stays fully evaluable: `TIED_CONVERSATION_IDS_SQL`'s member branch and the
 * release sweep's member branch both match the twin on the user id, and the
 * conversation holds and releases exactly as it would have. Deleting the
 * duplicate instead was rejected: this erasure preserves moderation history by
 * severing it from the person, never by removing rows. The residual cost is
 * that the stale row still names a slug the erased profile has freed, so a
 * member who later claims that slug would appear to be its subject; the twin is
 * the row staff act on, and this is noted for a follow-up rather than fixed by
 * weakening the guard.
 *
 * IDEMPOTENT under the retry loop: a re-run finds only rows still keyed to the
 * slug and skips the same colliding ones, so it converges and can never raise
 * 23505 a second time.
 *
 * $1 = user id, $2 = profile slug.
 */
export const REKEY_SLUG_MEMBER_REPORTS_SQL = `
  UPDATE "reports" SET "subject_id" = $1
  WHERE "subject_type" = 'member'
    AND "subject_id" = $2
    AND NOT (
      "status" = 'open'
      AND EXISTS (
        SELECT 1 FROM "reports" "twin"
        WHERE "twin"."subject_type" = 'member'
          AND "twin"."subject_id" = $1
          AND "twin"."status" = 'open'
          AND "twin"."reporter_id" = "reports"."reporter_id"
      )
    )
`;

/**
 * The conversations whose messages from this member must be HELD. Driven from
 * the (small) set of open reports rather than from the member's messages, so a
 * heavy chat user costs a handful of index lookups instead of one subquery per
 * message. The CASE keeps a non-uuid `subject_id` from failing the cast and lets
 * the join use the `messages` primary key.
 *
 * SYSTEM PILLS ARE NOT A TIE. `"tied"."kind" <> 'system'` mirrors the same
 * exclusion in `MARK_HELD_MESSAGES_SQL`, so the three steps share ONE
 * definition of "tied". Without it a report filed on a system pill counted as a
 * tie here, but the mark step then held nothing in that conversation (it skips
 * system rows) and the release re-check only looks at HELD siblings, so the
 * conversation was reported as held while holding nothing and released on the
 * sweep's first pass. The member's real messages there were tombstoned at
 * erasure time regardless, which is the outcome the tie was meant to prevent.
 * A pill is an audit line whose `sender_id` is the event's actor rather than
 * something the member wrote, so it is excluded from holding and tombstoning
 * alike.
 *
 * $1 = user id. Must run while `sender_id` still holds it (before the user row
 * is deleted), and after `REKEY_SLUG_MEMBER_REPORTS_SQL`.
 */
export const TIED_CONVERSATION_IDS_SQL = `
  SELECT "tied"."conversation_id" AS "conversationId"
  FROM "reports" "report"
  JOIN "messages" "tied"
    ON "tied"."id" = CASE
      WHEN "report"."subject_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN "report"."subject_id"::uuid
    END
  WHERE "report"."subject_type" = 'message'
    AND "report"."status" IN ${HOLDING_REPORT_STATUS_SQL}
    AND "tied"."sender_id" = $1
    AND "tied"."kind" <> 'system'
  UNION
  SELECT "participant"."conversation_id" AS "conversationId"
  FROM "reports" "report"
  JOIN "conversation_participants" "participant"
    ON "participant"."user_id" = "report"."reporter_id"
  WHERE "report"."subject_type" = 'member'
    AND "report"."status" IN ${HOLDING_REPORT_STATUS_SQL}
    AND "report"."subject_id" = $1::text
`;

/** $1 = user id, $2 = uuid[] of tied conversation ids. */
export const MARK_HELD_MESSAGES_SQL = `
  UPDATE "messages" SET "erased_sender_ref" = $1
  WHERE "sender_id" = $1
    AND "kind" <> 'system'
    AND "conversation_id" = ANY($2::uuid[])
`;

/**
 * Tombstone ONE keyset page of the member's messages and return the ids it
 * wrote, in a single statement. Held rows are excluded by
 * `erased_sender_ref IS NULL` (they were marked first).
 *
 * One statement rather than the SELECT-then-UPDATE pair this replaced: the
 * whole loop runs inside the erasure transaction, so halving the statements
 * halves the round trips the transaction stays open for. The inner page is an
 * index range scan on `IDX_messages_sender_id_id` (`(sender_id, id)`, added by
 * `KeepCounterpartMessagesOnSenderErasure1820530000000`); before that index the
 * only usable one was `(sender_id)` alone, so every page re-read the member's
 * whole history and sorted it just to find the next thousand ids.
 *
 * The keyset cursor is what terminates the loop, and it is NOT optional: a
 * tombstoned row keeps `sender_id` and `erased_sender_ref IS NULL`, so it
 * matches this predicate again forever. The caller advances `$2` past the
 * highest id `RETURNING` handed back.
 *
 * $1 = user id, $2 = last id of the previous page (the nil uuid for the first),
 * $3 = page size.
 */
export const TOMBSTONE_SENDER_MESSAGE_PAGE_SQL = `
  UPDATE "messages" SET ${ERASED_SENDER_TOMBSTONE_ASSIGNMENTS_SQL}
  WHERE "id" IN (
    SELECT "page"."id" FROM "messages" "page"
    WHERE "page"."sender_id" = $1
      AND "page"."kind" <> 'system'
      AND "page"."erased_sender_ref" IS NULL
      AND "page"."id" > $2::uuid
    ORDER BY "page"."id" ASC
    LIMIT $3
  )
  RETURNING "id"
`;

/** The first keyset cursor: sorts before every real uuid. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * (c) One batch of the release sweep: tombstone up to $1 held rows whose
 * conversation no longer holds an open or escalated tied report. The tie is
 * re-evaluated inside the same statement that writes, so a report filed on a
 * held message a moment ago keeps it held. Idempotent: a released row has
 * `erased_sender_ref` NULL and never matches again.
 *
 * $1 = batch size.
 */
export const RELEASE_UNTIED_HELD_MESSAGES_SQL = `
  UPDATE "messages" SET ${ERASED_SENDER_TOMBSTONE_ASSIGNMENTS_SQL}
  WHERE "id" IN (
    SELECT "held"."id" FROM "messages" "held"
    WHERE "held"."erased_sender_ref" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "reports" "report"
        WHERE "report"."status" IN ${HOLDING_REPORT_STATUS_SQL}
          AND (
            (
              "report"."subject_type" = 'message'
              AND "report"."subject_id" IN (
                SELECT "sibling"."id"::text FROM "messages" "sibling"
                WHERE "sibling"."erased_sender_ref" = "held"."erased_sender_ref"
                  AND "sibling"."conversation_id" = "held"."conversation_id"
              )
            )
            OR (
              "report"."subject_type" = 'member'
              AND "report"."subject_id" = "held"."erased_sender_ref"::text
              AND EXISTS (
                SELECT 1 FROM "conversation_participants" "participant"
                WHERE "participant"."conversation_id" = "held"."conversation_id"
                  AND "participant"."user_id" = "report"."reporter_id"
              )
            )
          )
      )
    ORDER BY "held"."id" ASC
    LIMIT $1
  )
`;
