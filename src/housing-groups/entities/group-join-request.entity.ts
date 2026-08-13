import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { HousingGroup } from './housing-group.entity';

export enum GroupJoinRequestStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
}

/**
 * One answer to a screening question, snapshotting the prompt text so an admin
 * reviewer reads exactly what the applicant was asked (questions can change
 * after submission).
 */
export interface GroupScreeningAnswer {
  questionId: string;
  question: string;
  answer: string;
}

/**
 * A prospective member's request to join an access-gated group, modelled on
 * `CoopJoinRequest`. Carries their answers to the group's screening questions
 * plus a free-text note about their relationship to the community. A
 * steward/moderator approves or declines it.
 */
@Entity('group_join_requests')
export class GroupJoinRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_group_join_requests_group_id')
  @Column({ type: 'uuid' })
  groupId!: string;

  @ManyToOne(() => HousingGroup, (group) => group.joinRequests, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'group_id' })
  group!: HousingGroup;

  @Column({ type: 'varchar' })
  name!: string;

  /**
   * The applicant's own words on their relationship to the LGBTQ+ community —
   * the trust question the group model turns on.
   */
  @Column({ type: 'text' })
  relationship!: string;

  /** Answers to the group's `screeningQuestions`, snapshotted at submission. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  answers!: GroupScreeningAnswer[];

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  // Nullable: a signed-in member's id when they applied (enables the
  // mutual-connections trust signal). FK to `users(id)` ON DELETE SET NULL so an
  // account erasure nulls the requester while the request survives — mirrors
  // `CoopJoinRequest.userId`. Wired in the accompanying migration.
  @Index('IDX_group_join_requests_user_id')
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @Column({
    type: 'enum',
    enum: GroupJoinRequestStatus,
    enumName: 'group_join_requests_status_enum',
    default: GroupJoinRequestStatus.Pending,
  })
  status!: GroupJoinRequestStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
