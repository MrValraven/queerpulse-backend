import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GOV-01 — the storage behind member-filed motions.
 *
 * Until this existed, only an admin could put anything to the community:
 * `POST /governance/proposals` is admin-gated, so the public Governance page
 * promised members a vote on decisions members had no way to raise. A motion
 * closes that loop from the other end. A member files the QUESTION, the
 * community co-signs it past a threshold, and only then does an admin decide
 * whether it reaches a ballot and in what window.
 *
 * WHAT THIS CHANGES, and what it deliberately does not:
 *
 *   - The proposal ENUMS gain the states a motion moves through. Admin-opened
 *     proposals are untouched: they still start at `open` and end at
 *     `passed`/`failed`. A motion adds three states in front of that ballot
 *     (`gathering` -> `screening` -> `open`) plus the two ways it can end
 *     without one (`rejected` when staff decline it, `lapsed` when the
 *     co-signature window runs out short of the threshold).
 *
 *   - `governance_proposals` gains seven nullable columns, ALL of them NULL on
 *     an admin-opened proposal. `proposed_by_member_id` is kept distinct from
 *     the existing `created_by_member_id` on purpose: the proposer is the
 *     member the approve/reject bell goes to and the one who may not withdraw
 *     their founding co-signature, while `created_by_member_id` stays the
 *     staff audit pointer. `cosignature_threshold` is FROZEN per motion at
 *     filing time rather than read from the platform constant, so raising or
 *     lowering the bar can never move the target under a drive already
 *     running.
 *
 *   - `final_quorum_required` is left NULL on every already-resolved proposal.
 *     No backfill is attempted, because re-deriving a bar from today's active
 *     member count would be inventing the number a past outcome was judged
 *     against. `GovernanceProposalDTO` already reads NULL as "no recorded
 *     bar" and refuses to claim such a proposal missed one.
 *
 *   - `governance_proposal_cosignatures` records who put their name to a
 *     motion. A co-signature is emphatically NOT a vote: it says "put this to
 *     the community", and a co-signer stays free to vote the motion down once
 *     it reaches a ballot. The unique constraint leads with `proposal_id` —
 *     the same column the live count filters on — so this one index serves
 *     both the one-signature-per-member rule and the count, exactly as
 *     `UQ_governance_votes_proposal_member` does for ballots, and no second
 *     index is needed.
 *
 * TRANSACTIONAL, unlike the `ADD VALUE` migrations that opt out. On PostgreSQL
 * 12+ `ALTER TYPE ... ADD VALUE` is only barred from the wrapping transaction
 * when a statement in that same transaction USES the new label. Nothing here
 * does: every statement below is column, table, index and constraint DDL,
 * which never references an enum label, and no row is written. Same precedent
 * as `AddCommunityGovernanceSettingsChangedAction1793520200000` and
 * `AddStorySubmissionDecision1794833100000`. `IF NOT EXISTS` on each label
 * keeps the enum half re-run-safe.
 */
export class AddGovernanceMemberMotions1794780000000 implements MigrationInterface {
  name = 'AddGovernanceMemberMotions1794780000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- enum labels ---------------------------------------------------------
    // Added, never used below. See the transaction note in the class doc.
    await queryRunner.query(
      `ALTER TYPE "governance_proposals_type_enum" ADD VALUE IF NOT EXISTS 'member_motion'`,
    );
    await queryRunner.query(
      `ALTER TYPE "governance_proposals_status_enum" ADD VALUE IF NOT EXISTS 'gathering'`,
    );
    await queryRunner.query(
      `ALTER TYPE "governance_proposals_status_enum" ADD VALUE IF NOT EXISTS 'screening'`,
    );
    await queryRunner.query(
      `ALTER TYPE "governance_proposals_status_enum" ADD VALUE IF NOT EXISTS 'rejected'`,
    );
    await queryRunner.query(
      `ALTER TYPE "governance_proposals_status_enum" ADD VALUE IF NOT EXISTS 'lapsed'`,
    );
    // The three bells the motion lifecycle rings: staff hear a motion cleared
    // its threshold, the proposer hears what staff decided either way.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'governance_motion_ready_for_review'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'governance_motion_approved'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'governance_motion_rejected'`,
    );

    // --- governance_proposals: motion columns --------------------------------
    // All nullable, all NULL on an admin-opened proposal.
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "proposed_by_member_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "cosignature_threshold" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "gathering_closes_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "screening_decided_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "screening_decided_by_member_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "screening_note" text`,
    );
    // Deliberately left NULL for every proposal already resolved — see the
    // class doc on why no backfill is attempted.
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "final_quorum_required" integer`,
    );

    // `ON DELETE SET NULL` on both actor pointers, matching
    // `target_member_id` and `created_by_member_id`: a governance record must
    // outlive the erasure of the account that filed or screened it.
    await queryRunner.query(`
      ALTER TABLE "governance_proposals"
        ADD CONSTRAINT "FK_governance_proposals_proposed_by_member_id"
        FOREIGN KEY ("proposed_by_member_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "governance_proposals"
        ADD CONSTRAINT "FK_governance_proposals_screening_decided_by_member_id"
        FOREIGN KEY ("screening_decided_by_member_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // The two new filters the motion queries actually run. `status` is
    // already covered by `IDX_governance_proposals_status` from
    // `AddGovernanceProposalsAndVotes1787216454501`, so it is not duplicated
    // here.
    //   - `proposed_by_member_id`: the per-member open-drive cap checked on
    //     every filing.
    //   - `gathering_closes_at`: the daily lapse sweep
    //     (`GovernanceMotionSweeperService`) selects `gathering` motions whose
    //     window has run out.
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_proposals_proposed_by_member_id" ON "governance_proposals" ("proposed_by_member_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_proposals_gathering_closes_at" ON "governance_proposals" ("gathering_closes_at")`,
    );

    // --- governance_proposal_cosignatures ------------------------------------
    // `ON DELETE CASCADE` on both FKs, mirroring `governance_votes`: a
    // signature has nothing to point at once its motion is gone, and an erased
    // account takes its own signature with it. Losing the row is safe because
    // the fact that mattered — whether the threshold was met — is already
    // recorded by the motion having moved to `screening`.
    await queryRunner.query(`
      CREATE TABLE "governance_proposal_cosignatures" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "proposal_id" uuid NOT NULL,
        "member_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_governance_proposal_cosignatures" PRIMARY KEY ("id"),
        CONSTRAINT "FK_governance_proposal_cosignatures_proposal_id"
          FOREIGN KEY ("proposal_id") REFERENCES "governance_proposals"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_governance_proposal_cosignatures_member_id"
          FOREIGN KEY ("member_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    // `(proposal_id, member_id)` in that column order: leading with the column
    // the count query filters on lets this one index serve both the
    // one-signature-per-member rule and the live count. It is also the
    // constraint the idempotent `ON CONFLICT DO NOTHING` insert in
    // `GovernanceProposalService.cosign` conflicts on, which is what makes a
    // double tap a silent no-op instead of a 500.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_governance_proposal_cosignatures_proposal_member" ON "governance_proposal_cosignatures" ("proposal_id", "member_id")`,
    );
  }

  /**
   * ALL-OR-NOTHING, and it always lands on nothing.
   *
   * The column, index, constraint and table drops below are each individually
   * reversible and are written out in dependency order so a maintainer can
   * lift them into a hand-written follow-up. The enum labels are not
   * reversible, so this method ends by throwing, and because the migration
   * runs inside a transaction that throw rolls the drops back with it. A
   * revert therefore fails cleanly and changes nothing, which is the honest
   * outcome: a half-revert that took the columns but left the labels is worse
   * than no revert at all.
   *
   * Failing loudly beats reporting a successful revert that undid nothing. A
   * silent no-op would remove the ledger row while every object stayed in
   * place, so the next `migration:run` would treat this migration as pending
   * and re-run `up()` against a table and columns that already exist.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "UQ_governance_proposal_cosignatures_proposal_member"`,
    );
    await queryRunner.query(`DROP TABLE "governance_proposal_cosignatures"`);

    await queryRunner.query(
      `DROP INDEX "IDX_governance_proposals_gathering_closes_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_governance_proposals_proposed_by_member_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP CONSTRAINT "FK_governance_proposals_screening_decided_by_member_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP CONSTRAINT "FK_governance_proposals_proposed_by_member_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "final_quorum_required"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "screening_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "screening_decided_by_member_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "screening_decided_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "gathering_closes_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "cosignature_threshold"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "proposed_by_member_id"`,
    );

    // Postgres has no `ALTER TYPE ... DROP VALUE`. Rebuilding all three enum
    // types without these labels needs the rename-and-recreate dance (see
    // `RemovePendingStatus1782800740000`) plus a real data decision about what
    // any row still carrying `member_motion` or
    // `gathering`/`screening`/`rejected`/`lapsed` becomes, which this
    // migration must not silently guess at.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
