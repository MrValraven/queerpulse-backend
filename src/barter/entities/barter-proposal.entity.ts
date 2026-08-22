import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Where a proposal stands. `Pending` until the listing owner decides;
 * `Withdrawn` is deliberately absent — a proposer who changes their mind
 * carries that conversation in the DM thread the proposal opened, and there is
 * no state the owner needs to see beyond "came in / said yes / said no".
 */
export enum BarterProposalStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

/**
 * One member proposing a swap against someone else's {@link BarterListing}.
 *
 * The `UNIQUE (listing_id, proposer_id)` constraint makes a member's proposal
 * on a listing singular: re-proposing after a decline reactivates the same row
 * rather than stacking a second one (mirrors
 * `VolunteeringService.signup`'s reapply-after-decline precedent), so an
 * owner's inbox can never be flooded by one person.
 *
 * The `message` is also delivered to the owner's DM inbox at creation time
 * (see `BarterService.createProposal`), so the row is the structured record and
 * the conversation is where the swap is actually negotiated.
 */
@Entity('barter_proposals')
@Unique('UQ_barter_proposals_listing_proposer', ['listingId', 'proposerId'])
export class BarterProposal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_barter_proposals_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  @Index('IDX_barter_proposals_proposer_id')
  @Column({ type: 'uuid' })
  proposerId!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({
    type: 'enum',
    enum: BarterProposalStatus,
    default: BarterProposalStatus.Pending,
  })
  status!: BarterProposalStatus;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
