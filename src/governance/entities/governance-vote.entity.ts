import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum GovernanceVoteChoice {
  For = 'for',
  Against = 'against',
}

/**
 * One member's vote on a `GovernanceProposal`. The unique constraint enforces
 * one ROW per member per proposal; voting again while the window is open
 * UPDATES that row's `choice` (`GovernanceProposalService.castVote` upserts on
 * this constraint). The unique violation used to be swallowed instead, so a
 * member who voted `for` and then sent `against` got a 201 with their original
 * choice and an unmoved tally — success reported for a no-op (BE-COM-09).
 *
 * Unlike `RoadmapVote` (whose unique constraint leads with `memberId`, so a
 * separate `(targetType, targetId)` index is needed for the live tally),
 * this constraint leads with `proposalId` — the same column the tally query
 * filters on (`WHERE proposal_id = ?`) — so the unique index alone serves
 * both jobs and no second index is required.
 */
@Entity('governance_votes')
@Unique('UQ_governance_votes_proposal_member', ['proposalId', 'memberId'])
export class GovernanceVote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  proposalId!: string;

  @Column({ type: 'uuid' })
  memberId!: string;

  @Column({ type: 'enum', enum: GovernanceVoteChoice })
  choice!: GovernanceVoteChoice;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
