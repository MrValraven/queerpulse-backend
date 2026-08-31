import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The columns behind LOC-19, "close the four approval queues that go nowhere".
 * Sibling of `AddApprovalQueueNotificationTypes1794740000000`, which carries
 * the enum labels and therefore has to run non-transactionally; this one is
 * ordinary DDL and runs inside the migration transaction.
 *
 * Three things are added, and they are all the same thing: a decision that can
 * be read back.
 *
 * 1. `reading_group_proposal.created_community_slug` — approving a proposal
 *    now CREATES the community the member asked for, owned by them. This
 *    column holds that community's slug, which is both the deep link the
 *    proposer is sent and the idempotency key: a second approve on a row that
 *    already carries one is a no-op, so a double-click cannot mint two
 *    communities. A slug rather than a uuid FK, deliberately: a community's
 *    handle is creation-time only, so the slug is immutable, and like
 *    `decided_by` this is decision history that must outlive the thing it
 *    points at rather than being nulled out with it.
 *
 * 2. `group_listings.decided_at` / `decided_by` / `decision_reason` — the
 *    pre-publication review on a group listing recorded only the resulting
 *    `status`. Who decided, when, and why were nowhere, so a poster asking
 *    "why was my room not published?" had no answer and a second moderator had
 *    no history. `decided_by` carries no FK, mirroring
 *    `reading_group_proposal.decided_by`: a decision must outlive a staff
 *    account's deletion.
 *
 * 3. `landlords.decided_at` / `decided_by` / `decision_reason` and the same
 *    three on `landlord_intro_requests` — the same gap on the two landlord
 *    queues. A member suggests a directory entry or asks for an introduction,
 *    a moderator decides, and until now nothing recorded the decision beyond
 *    the row's own status.
 *
 * No index is added on any of them: none is a filter or a sort key. The
 * queues sort by `created_at` and filter by `status`, both already indexed.
 */
export class AddApprovalQueueDecisionAudit1794741000000 implements MigrationInterface {
  name = 'AddApprovalQueueDecisionAudit1794741000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" ADD "created_community_slug" character varying(200)`,
    );

    await queryRunner.query(
      `ALTER TABLE "group_listings" ADD "decided_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" ADD "decided_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" ADD "decision_reason" text`,
    );

    await queryRunner.query(
      `ALTER TABLE "landlords" ADD "decided_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`ALTER TABLE "landlords" ADD "decided_by" uuid`);
    await queryRunner.query(
      `ALTER TABLE "landlords" ADD "decision_reason" text`,
    );

    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" ADD "decided_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" ADD "decided_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" ADD "decision_reason" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" DROP COLUMN "decision_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" DROP COLUMN "decided_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_intro_requests" DROP COLUMN "decided_at"`,
    );

    await queryRunner.query(
      `ALTER TABLE "landlords" DROP COLUMN "decision_reason"`,
    );
    await queryRunner.query(`ALTER TABLE "landlords" DROP COLUMN "decided_by"`);
    await queryRunner.query(`ALTER TABLE "landlords" DROP COLUMN "decided_at"`);

    await queryRunner.query(
      `ALTER TABLE "group_listings" DROP COLUMN "decision_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" DROP COLUMN "decided_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" DROP COLUMN "decided_at"`,
    );

    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" DROP COLUMN "created_community_slug"`,
    );
  }
}
