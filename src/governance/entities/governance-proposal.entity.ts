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
  /** A motion filed by an ordinary member rather than opened by an admin
   *  (GOV-01). It has to gather co-signatures and pass staff screening before
   *  it ever reaches a vote, so it enters at `gathering` and only becomes an
   *  `open` ballot once an admin approves it with a voting window. */
  MemberMotion = 'member_motion',
}

/**
 * The lifecycle a proposal moves through.
 *
 * Admin-opened proposals (`POST /governance/proposals`) still start at `open`
 * and end at `passed`/`failed`, unchanged. A member motion adds the three
 * states in front of that ballot plus the two ways it can end without one:
 *
 *   gathering -> screening -> open -> passed | failed
 *   gathering -> rejected          (staff declined it before it was screened)
 *   screening -> rejected          (staff declined it after the drive closed)
 *   gathering -> lapsed            (the co-signature window ran out)
 */
export enum GovernanceProposalStatus {
  Open = 'open',
  Passed = 'passed',
  Failed = 'failed',
  /** Collecting co-signatures. Visible to members, not yet votable. */
  Gathering = 'gathering',
  /** Threshold reached; waiting on a staff decision. */
  Screening = 'screening',
  /** Staff declined to put it to a vote. `screeningNote` says why. */
  Rejected = 'rejected',
  /** The co-signature window closed short of the threshold. */
  Lapsed = 'lapsed',
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

  /**
   * The quorum the outcome was judged against, frozen by
   * `GovernanceProposalService.resolveIfClosed` in the SAME write as
   * `finalFor`/`finalAgainst`. Quorum is a percentage of the live active
   * member count, so re-deriving it at render time would silently re-judge an
   * already-decided proposal every time the community grows or shrinks.
   *
   * NULL for every proposal resolved before this column existed, which is why
   * `failedForQuorum` on the DTO is false whenever it is NULL: we cannot claim
   * a proposal missed a bar nobody recorded.
   */
  @Column({ type: 'int', nullable: true })
  finalQuorumRequired!: number | null;

  // ── Member motions (GOV-01) ──────────────────────────────────────────────
  // All NULL on an admin-opened proposal.

  /**
   * The member who FILED this motion, distinct from `createdByMemberId` (the
   * admin who opened an admin proposal). Keeping them apart matters: the
   * proposer is the person the approve/reject notification goes to and the one
   * who may not withdraw their founding co-signature, while
   * `createdByMemberId` stays the staff audit pointer.
   *
   * `ON DELETE SET NULL` like every other actor pointer in this module: the
   * motion outlives the erasure of the account that filed it.
   */
  @Index('IDX_governance_proposals_proposed_by_member_id')
  @Column({ type: 'uuid', nullable: true })
  proposedByMemberId!: string | null;

  /**
   * The number of co-signatures this motion needs, FROZEN at filing time from
   * `COSIGNATURE_THRESHOLD`. Stored rather than read from the constant so
   * raising or lowering the platform-wide bar cannot move the target under a
   * drive that is already running.
   */
  @Column({ type: 'int', nullable: true })
  cosignatureThreshold!: number | null;

  // When the co-signature drive runs out. Indexed: the daily lapse sweep
  // (`GovernanceMotionSweeperService`) filters `gathering` motions by it.
  @Index('IDX_governance_proposals_gathering_closes_at')
  @Column({ type: 'timestamptz', nullable: true })
  gatheringClosesAt!: Date | null;

  // When staff approved or rejected the motion, and who did.
  @Column({ type: 'timestamptz', nullable: true })
  screeningDecidedAt!: Date | null;

  // `ON DELETE SET NULL`, same reasoning as `proposedByMemberId`.
  @Column({ type: 'uuid', nullable: true })
  screeningDecidedByMemberId!: string | null;

  /** Required on a rejection, optional on an approval: the reason staff give
   *  the proposer, surfaced back to them on the motion. */
  @Column({ type: 'text', nullable: true })
  screeningNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
