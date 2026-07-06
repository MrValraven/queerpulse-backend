import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum JoinRequestStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
}

// Note: the "at most one pending join request per (community, user)" rule is
// enforced by a partial unique index in the migration
// (`UQ_community_join_requests_pending` ... WHERE status = 'pending'), not by
// a TypeORM decorator — mirrors `join-request.entity.ts` +
// `AddJoinRequestPendingUnique`.
@Entity('community_join_requests')
export class CommunityJoinRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_community_join_requests_community_id')
  @Column({ type: 'uuid' })
  communityId: string;

  @Index('IDX_community_join_requests_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({
    type: 'enum',
    enum: JoinRequestStatus,
    enumName: 'community_join_requests_status_enum',
    default: JoinRequestStatus.Pending,
  })
  status: JoinRequestStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
