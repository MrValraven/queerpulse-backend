import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** What a proposal is asking the community to decide. Mirrors the two
 *  promises made on the public Governance page: advisory-council seats can be
 *  removed by "a two-thirds community vote", and a corporate-funding policy
 *  change would go to "the community will vote on it". */
export enum GovernanceProposalType {
  CouncilRemoval = 'council_removal',
  FundingChange = 'funding_change',
}

export enum GovernanceProposalStatus {
  Open = 'open',
  Passed = 'passed',
  Failed = 'failed',
}

/**
 * A member-votable governance proposal — backs the "two-thirds community
 * vote" promise on `/about/governance` (removing an advisory-council seat)
 * and the "community will vote on it" promise for a corporate-funding policy
 * change. Modeled directly on the roadmap module's real member-voting
 * pattern (`RoadmapVote`/`RoadmapService`): tallying is live, computed from
 * `governance_votes` rows on every read, never a denormalized counter.
 *
 * `targetMemberId` only applies to `council_removal` (which member's seat is
 * up for removal) and is left null for `funding_change`. Scope boundary: a
 * `passed` council-removal proposal only flips `status` — the advisory
 * council itself is curated content (`governance_overview.council`, a jsonb
 * array with no relational roster), so actually removing/replacing the seat
 * stays a manual admin follow-up, not something this table can safely
 * automate.
 */
@Entity('governance_proposals')
export class GovernanceProposal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: GovernanceProposalType })
  type!: GovernanceProposalType;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  // FK is `ON DELETE SET NULL` (added in the migration) — a proposal must
  // outlive the erasure of the account it names, mirroring
  // `roadmap_ideas.submitted_by_id`.
  @Column({ type: 'uuid', nullable: true })
  targetMemberId!: string | null;

  // Whether the vote is still open, or has been lazily tallied to a final
  // outcome — see `GovernanceProposalService.resolveIfClosed`.
  @Index('IDX_governance_proposals_status')
  @Column({
    type: 'enum',
    enum: GovernanceProposalStatus,
    default: GovernanceProposalStatus.Open,
  })
  status!: GovernanceProposalStatus;

  @Column({ type: 'timestamptz' })
  opensAt!: Date;

  // Indexed: `resolveIfClosed` filters open proposals by whether this has
  // passed, and the public list orders open proposals by it.
  @Index('IDX_governance_proposals_closes_at')
  @Column({ type: 'timestamptz' })
  closesAt!: Date;

  // Who opened the proposal (an admin). `ON DELETE SET NULL`, like every
  // other actor pointer in this module — the record survives erasure of its
  // author's account.
  @Column({ type: 'uuid', nullable: true })
  createdByMemberId!: string | null;

  /**
   * The vote counts frozen at the moment this proposal resolved — written
   * once by `GovernanceProposalService.resolveIfClosed`, never updated
   * afterwards. NULL while the proposal is still `open`, in which case the
   * live tally over `governance_votes` is what gets rendered.
   *
   * `governance_votes.member_id` is `ON DELETE CASCADE`, so an erased
   * member's ballot disappears with their account — which is the right
   * privacy behaviour for the individual row, but it used to silently move
   * the displayed for/against of an already-decided proposal, so a
   * "passed at 67%" could later render at 60% (BE-COM-31). The aggregate is
   * what has to outlive the voter, not the ballot.
   */
  @Column({ type: 'int', nullable: true })
  finalFor!: number | null;

  @Column({ type: 'int', nullable: true })
  finalAgainst!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
