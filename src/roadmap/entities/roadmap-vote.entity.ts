import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum RoadmapVoteTarget {
  Item = 'item',
  Idea = 'idea',
}

/**
 * One member's vote for a `roadmap_items` (planned) card or a
 * `roadmap_ideas` row. The unique constraint enforces one vote per member per
 * target — no relation/FK to the target table since `targetId` points at
 * either `roadmap_items` or `roadmap_ideas` depending on `targetType`.
 */
@Entity('roadmap_votes')
@Unique('UQ_roadmap_votes_member_target', [
  'memberId',
  'targetType',
  'targetId',
])
export class RoadmapVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  memberId: string;

  @Column({ type: 'enum', enum: RoadmapVoteTarget })
  targetType: RoadmapVoteTarget;

  @Column({ type: 'uuid' })
  targetId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
