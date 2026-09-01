// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `submission_decided` and `review_replied`, the two `notifications_type_enum`
 * values behind the shared intake primitive in `src/submissions/` (PRD-48).
 *
 * The gap they close. There was no shared "somebody applied for a thing" row:
 * every intake grew its own entity, its own status vocabulary and its own
 * decision endpoint, and whether the person who submitted ever heard back was
 * decided one intake at a time. That is why a partner application (PRD-37), a
 * barter proposal (PRD-43) and a suggested resource (PRD-45) each had to be
 * found as a separate silent black hole rather than fixed once.
 *
 * `submission_decided` goes to the MEMBER WHO SUBMITTED when the reviewing side
 * reaches a terminal outcome, written by `SubmissionDecisionNotifier`. One value
 * covers every adopting intake: `payload.kind` (a `SubmissionKind`) and
 * `payload.outcome` (`accepted` / `declined` / `archived`) are the two
 * discriminators the copy branches on, the same choice `intake_reviewed` makes
 * with its `kind` and `report_filed` with its `severity`. A fourth intake is
 * then a code-only change with no `ALTER TYPE` at all. System-driven: no actor
 * id, so the bell never names who decided and a block between the submitter and
 * whoever was on the rota cannot swallow the answer; and no preference category,
 * because this is the outcome of something the member themself asked for.
 *
 * `review_replied` goes to the AUTHOR OF A REVIEW when the SUBJECT of that
 * review answers it in public, written by `ReviewReplyNotifier`. It DOES carry
 * an actor (`payload.actorId`, the replying owner/employer/lister), because it
 * is one member answering another member in public and has to sit behind the
 * same block/mute gate `listing_public_question_answered` sits behind. A
 * moderator-written reply omits the actor and reads as the platform speaking.
 * The reply TEXT never rides on the payload: it is already published on the page
 * the row links to.
 *
 * IN-APP (plus push where the push whitelist takes them). QueerPulse sends no
 * email and never will, so no copy for either type may say anything is on its
 * way.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here
 * (e.g. `AddBanEvasionEscalationNotificationTypes1796200000000`): a new label
 * must be COMMITTED before any statement may use it, so this opts out of the
 * wrapping transaction (`transaction = false`, honoured because `data-source.ts`
 * sets `migrationsTransactionMode: 'each'`). Nothing in this file uses either
 * label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddSubmissionAndReviewNotificationTypes1796400000000 implements MigrationInterface {
  name = 'AddSubmissionAndReviewNotificationTypes1796400000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'submission_decided'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'review_replied'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added labels
    // are inert once nothing writes them. Fails loudly rather than reporting a
    // successful revert that undid nothing, which would drop the ledger row and
    // make the next `migration:run` error on labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
