import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Snapshots a governance proposal's final vote counts when it resolves
 * (BE-COM-31).
 *
 * `governance_votes.member_id` is `ON DELETE CASCADE`
 * (`1787216454501-AddGovernanceProposalsAndVotes`), so a member exercising
 * their right to erasure takes their vote rows with them. `tallyFor` counts
 * live rows, so a proposal recorded as "passed" could later render at a
 * for-percentage below the threshold that passed it — a transparency page
 * showing numbers that contradict its own stated outcome.
 *
 * Two nullable counters rather than changing the FK to `ON DELETE SET NULL`:
 * the cascade is the right privacy behaviour (an erased member's individual
 * ballot should not survive them), and what needs to survive is the aggregate,
 * not the row. NULL means "not yet resolved" — an open proposal keeps
 * rendering its live tally, exactly as before, and only the resolved outcome
 * is frozen.
 *
 * Backfill: existing resolved proposals get their current live tally written
 * in, which is the best available reconstruction. Rows whose voters have
 * already been erased cannot be recovered — the counts were never stored.
 */
export class AddGovernanceProposalFinalTally1793620300000 implements MigrationInterface {
  name = 'AddGovernanceProposalFinalTally1793620300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "final_for" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" ADD "final_against" integer`,
    );
    await queryRunner.query(`
      UPDATE "governance_proposals" p
      SET "final_for" = COALESCE(counts.for_count, 0),
          "final_against" = COALESCE(counts.against_count, 0)
      FROM (
        SELECT
          v."proposal_id" AS proposal_id,
          COUNT(*) FILTER (WHERE v."choice" = 'for') AS for_count,
          COUNT(*) FILTER (WHERE v."choice" = 'against') AS against_count
        FROM "governance_votes" v
        GROUP BY v."proposal_id"
      ) AS counts
      WHERE counts.proposal_id = p."id" AND p."status" <> 'open'
    `);
    // A resolved proposal that has no vote rows at all is missed by the join
    // above; it still needs zeros rather than NULL, or it would fall back to
    // the (also empty) live tally forever.
    await queryRunner.query(`
      UPDATE "governance_proposals"
      SET "final_for" = 0, "final_against" = 0
      WHERE "status" <> 'open' AND "final_for" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "final_against"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_proposals" DROP COLUMN "final_for"`,
    );
  }
}
