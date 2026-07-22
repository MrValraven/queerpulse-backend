import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum LandlordIntroRequestStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

/**
 * A stored "request an introduction" against a landlord, actioned by the
 * moderator/facilitator team (a landlord isn't a member, so there is no inbox
 * delivery). Mirrors the co-ops `coop_join_requests` pattern.
 */
@Entity('landlord_intro_requests')
export class LandlordIntroRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_landlord_intro_requests_landlord_id')
  @Column({ type: 'uuid' })
  landlordId: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'varchar', nullable: true })
  contactEmail: string | null;

  @Index('IDX_landlord_intro_requests_status')
  @Column({
    type: 'enum',
    enum: LandlordIntroRequestStatus,
    enumName: 'landlord_intro_requests_status_enum',
    default: LandlordIntroRequestStatus.Pending,
  })
  status: LandlordIntroRequestStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
