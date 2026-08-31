// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-02. Two columns on `join_requests` that let an approval's invite window
 * start when the APPLICANT is told about it, rather than at the moment a
 * reviewer clicked approve.
 *
 * WHY. `JoinRequestsService.review` mints a 7-day, email-pinned invite on
 * approval, and QueerPulse sends no email, so nothing carries that invite to
 * the applicant. The only delivery is the applicant returning to
 * `/join-requests/status` with the token they were handed at submit time.
 * `InviteExpirySweeperService` then reclaims the invite on day 7 and the
 * status page shows the "invite is gone" screen. An applicant who came back on
 * day 8 met a dead end for a decision that had gone their way, and nothing had
 * ever told them a clock was running.
 *
 * `approval_seen_at`: the first time the applicant's own status lookup
 * returned their invite code. Null while nobody has looked. The service uses
 * it as a one-shot latch: on the first read that hands the code over it stamps
 * this column with a conditional `approval_seen_at IS NULL` update, and only
 * the winning read re-pins `invites.expires_at` to seven days from that
 * moment. Two concurrent reloads therefore start the window once, not twice.
 *
 * `invite_refresh_count`: how many times the applicant has used the status
 * page's own "my link lapsed, give me a fresh one" action
 * (`POST /join-requests/status/invite/refresh`). Bounded in the service so an
 * approval cannot be renewed forever from a token that may itself have leaked;
 * a reviewer's `POST /admin/join-requests/:id/invite/reissue` is unaffected and
 * deliberately does not increment it, because that path has a human behind it.
 *
 * Both columns are nullable / defaulted, so every existing row is valid
 * without a backfill. An already-approved row keeps `approval_seen_at NULL`,
 * which reads as "the applicant has not seen it yet", correct for the ones
 * still waiting, and harmless for the ones long since redeemed, since the
 * latch only ever fires for an invite that still resolves as valid.
 */
export class AddJoinRequestApprovalDelivery1796030000000 implements MigrationInterface {
  name = 'AddJoinRequestApprovalDelivery1796030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "approval_seen_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "invite_refresh_count" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP COLUMN "invite_refresh_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP COLUMN "approval_seen_at"`,
    );
  }
}
