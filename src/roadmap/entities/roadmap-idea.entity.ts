import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum RoadmapIdeaStatus {
  Pending = 'pending',
  Published = 'published',
  Dismissed = 'dismissed',
}

/**
 * A member-submitted feature idea. `pending` ideas await a moderator/admin
 * decision; `published` ones are the "Top ideas" list rendered on
 * `/about/roadmap` (seeded from the frontend's `TOP_IDEAS` in
 * `queerpulse/src/features/marketing/roadmap.data.ts`, all published);
 * `dismissed` ones are hidden but kept for the audit trail.
 */
@Entity('roadmap_ideas')
@Index('IDX_roadmap_ideas_status_sort', ['status', 'sortOrder'])
export class RoadmapIdea {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  text: string;

  @Column({ type: 'enum', enum: RoadmapIdeaStatus, default: RoadmapIdeaStatus.Pending })
  status: RoadmapIdeaStatus;

  // Starting seed count; member votes accrue on top via `roadmap_votes`.
  @Column({ type: 'int', default: 0 })
  votes: number;

  // Null for seeded ideas with no attributed submitter.
  @Column({ type: 'uuid', nullable: true })
  submittedById: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
