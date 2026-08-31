import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `governance_proposals` / `governance_votes` tables backing the
 * real member-vote system (COM-1): the public Governance page promises
 * advisory-council seats can be removed by "a two-thirds community vote" and
 * that funding-policy changes go to "the community will vote on it" — until
 * now, no proposal/vote schema existed anywhere to back those promises.
 *
 * Modeled directly on `1785002000000-CreateRoadmap`'s `roadmap_votes` table:
 *
 * - `governance_proposals` — one row per proposal an admin opens for a fixed
 *   voting window (`opens_at`/`closes_at`). `target_member_id` FK is
 *   `ON DELETE SET NULL` (nullable — only meaningful for `council_removal`;
 *   a proposal must outlive erasure of the account it names, mirroring
 *   `roadmap_ideas.submitted_by_id`). `created_by_member_id` FK is likewise
 *   `ON DELETE SET NULL`, mirroring every other actor pointer in this module
 *   (e.g. `governance_finance_report.metrics_edited_by`).
 * - `governance_votes` — one row per member vote on a proposal, unique per
 *   (proposal, member) so double-voting is a constraint violation rather
 *   than app-level bookkeeping (`member_id` FK `ON DELETE CASCADE`, mirroring
 *   `roadmap_votes.member_id` — a vote is meaningless without its member).
 *   Unlike `roadmap_votes`, no extra index is needed for the live tally
 *   query: the unique constraint already leads with `proposal_id`, which is
 *   the column the tally groups by.
 */
export class AddGovernanceProposalsAndVotes1787216454501 implements MigrationInterface {
  name = 'AddGovernanceProposalsAndVotes1787216454501';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- enums -------------------------------------------------------------
    await queryRunner.query(`
      CREATE TYPE "governance_proposals_type_enum" AS ENUM ('council_removal', 'funding_change')
    `);
    await queryRunner.query(`
      CREATE TYPE "governance_proposals_status_enum" AS ENUM ('open', 'passed', 'failed')
    `);
    await queryRunner.query(`
      CREATE TYPE "governance_votes_choice_enum" AS ENUM ('for', 'against')
    `);

    // --- governance_proposals ------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "governance_proposals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" "governance_proposals_type_enum" NOT NULL,
        "title" character varying(200) NOT NULL,
        "description" text NOT NULL,
        "target_member_id" uuid,
        "status" "governance_proposals_status_enum" NOT NULL DEFAULT 'open',
        "opens_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "closes_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_by_member_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_governance_proposals" PRIMARY KEY ("id"),
        CONSTRAINT "FK_governance_proposals_target_member_id"
          FOREIGN KEY ("target_member_id") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_governance_proposals_created_by_member_id"
          FOREIGN KEY ("created_by_member_id") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_proposals_status" ON "governance_proposals" ("status")`,
    );
    // Backs `resolveIfClosed` (which proposals are open past `closes_at`) and
    // the public list's ordering.
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_proposals_closes_at" ON "governance_proposals" ("closes_at")`,
    );

    // --- governance_votes ----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "governance_votes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "proposal_id" uuid NOT NULL,
        "member_id" uuid NOT NULL,
        "choice" "governance_votes_choice_enum" NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_governance_votes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_governance_votes_proposal_member" UNIQUE ("proposal_id", "member_id"),
        CONSTRAINT "FK_governance_votes_proposal_id"
          FOREIGN KEY ("proposal_id") REFERENCES "governance_proposals"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_governance_votes_member_id"
          FOREIGN KEY ("member_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "governance_votes"`);
    await queryRunner.query(`DROP INDEX "IDX_governance_proposals_closes_at"`);
    await queryRunner.query(`DROP INDEX "IDX_governance_proposals_status"`);
    await queryRunner.query(`DROP TABLE "governance_proposals"`);
    await queryRunner.query(`DROP TYPE "governance_votes_choice_enum"`);
    await queryRunner.query(`DROP TYPE "governance_proposals_status_enum"`);
    await queryRunner.query(`DROP TYPE "governance_proposals_type_enum"`);
  }
}
