// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `forum_thread_reviewed`, the `notifications_type_enum` value behind the
 * verdict a moderator returns on a thread its author sent to review.
 *
 * WHY IT EXISTS. `CreateThreadDto.submitForReview` lets an author hold their
 * own thread back for the editors or the council, and a pending thread is
 * invisible to every member-facing read path until somebody approves it. Until
 * this value there was no channel at all for the answer: the author's thread
 * simply stayed dark, and the only way to learn it had been approved (or that
 * it never would be) was to reopen its own link and read the state off the
 * page. QueerPulse sends no email, so the bell is the entire channel.
 *
 * WHAT IS WRITTEN UNDER IT. Exactly one row per DECISION, to the thread's
 * `author_id`, written by `ForumThreadsService.reviewThread` once the new
 * `review_state` has committed. A second decision cannot be made on the same
 * thread (the service refuses anything that is not still `pending`), so a
 * thread produces at most one of these.
 *
 * NO ACTOR, and that is a decision rather than an omission. The payload carries
 * no user id and the emit site passes no `actorId`, so the row reads as the
 * platform speaking and no block or mute can swallow it. This matches every
 * other staff-triage verdict in the enum (`HousingJoinDecided`,
 * `StorySubmissionDecided`, `ReadingGroupProposalDecided`): the bell never
 * names which moderator decided, because naming them turns a review into a
 * person for the author to answer, and the review queue exists so sensitive
 * threads are read before they are published, not so the reader is exposed.
 *
 * NO PREFERENCE CATEGORY. It joins `ALWAYS_DELIVERED_NOTIFICATION_TYPES` under
 * that list's fourth heading, "a decision on something you asked for", beside
 * `VolunteerApplicationDecided` and `WriterApplicationApproved`. A volume
 * control able to silence it would restore exactly the silence it exists to
 * end.
 *
 * IT DOES PUSH, unlike the report types. Those stay off the push whitelist
 * because the member is holding the phone that just filed the report; this one
 * arrives whenever a moderator gets to the queue, which can be days later and
 * is never a moment the author is watching for. It pushes unconditionally, the
 * way the four approval queues in `push-notification.listener.ts` already do,
 * and the copy names only the author's OWN thread title.
 *
 * IN-APP AND PUSH ONLY. QueerPulse sends no email and never will, so nothing
 * about this type may be described as one.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `notifications_type_enum`
 * `ADD VALUE` migration here: the label must be COMMITTED before any statement
 * may use it, so this opts out of the wrapping transaction (`transaction =
 * false`, honoured because `data-source.ts` sets `migrationsTransactionMode:
 * 'each'`). Nothing in this file uses the new label, and `IF NOT EXISTS` keeps
 * it re-run-safe — the one place in this directory where that guard is correct.
 */
export class AddForumThreadReviewedNotificationType1817320000000 implements MigrationInterface {
  name = 'AddForumThreadReviewedNotificationType1817320000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'forum_thread_reviewed'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added label
    // is inert once nothing writes it. Fails loudly rather than reporting a
    // successful revert that undid nothing, which would drop the ledger row
    // and make the next `migration:run` error on a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
