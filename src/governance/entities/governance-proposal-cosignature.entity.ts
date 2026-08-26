import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * One member's co-signature on a member-filed motion (GOV-01) — the "ten
 * members are behind this" signal that moves a motion from `gathering` to
 * `screening`. A co-signature is emphatically NOT a vote: it says "this
 * deserves to be put to the community", and the member who co-signs is free to
 * vote against the motion once it reaches a ballot.
 *
 * The proposer is inserted as their own first co-signature in the same
 * transaction that creates the motion, so a threshold of ten means the proposer
 * plus nine other members.
 *
 * Like `GovernanceVote`'s constraint, the unique index leads with `proposalId`
 * — the same column the count query filters on (`WHERE proposal_id = ?`) — so
 * this one index serves both the "one signature per member" rule and the live
 * count, and no second index is required. The idempotent `ON CONFLICT DO
 * NOTHING` insert in `GovernanceProposalService.cosign` conflicts on this
 * constraint, which is what makes a double tap a silent no-op instead of a 500.
 */
@Entity('governance_proposal_cosignatures')
@Unique('UQ_governance_proposal_cosignatures_proposal_member', [
  'proposalId',
  'memberId',
])
export class GovernanceProposalCosignature {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // FK is `ON DELETE CASCADE`: a co-signature has nothing to point at once
  // its motion is gone.
  @Column({ type: 'uuid' })
  proposalId!: string;

  // FK is `ON DELETE CASCADE`, matching `governance_votes.member_id` — an
  // erased account takes its own signature with it. The count that mattered
  // (whether the threshold was met) is already recorded by the motion having
  // moved to `screening`.
  @Column({ type: 'uuid' })
  memberId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
