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
 * Why a `dismissed` idea isn't being built — shown on the public "Not
 * building this, and why" section. Stored as `varchar`, not a Postgres enum,
 * so the admin service can validate it against the frozen contract's closed
 * set (`decline-idea.dto.ts`, Task A3) without a schema migration if the set
 * ever grows. The const array is the runtime companion `DeclineIdeaDto`
 * `@IsIn()`s against — one source of truth for the closed set.
 */
export const ROADMAP_DECLINE_REASONS = [
  'scope',
  'unsafe',
  'capacity',
  'exists',
  'harm',
] as const;
export type RoadmapDeclineReason = (typeof ROADMAP_DECLINE_REASONS)[number];

/**
 * A member-submitted feature idea. `pending` ideas await a moderator/admin
 * decision; `published` ones are the "Top ideas" list rendered on
 * `/about/roadmap` (seeded from the frontend's `TOP_IDEAS` in
 * `queerpulse/src/features/marketing/roadmap.data.ts`, all published);
 * `dismissed` ones are hidden from the queue but kept for the audit trail —
 * and, when `declineReason` is set, surfaced publicly as "not building this".
 */
@Entity('roadmap_ideas')
@Index('IDX_roadmap_ideas_status_sort', ['status', 'sortOrder'])
export class RoadmapIdea {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  text!: string;

  @Column({
    type: 'enum',
    enum: RoadmapIdeaStatus,
    default: RoadmapIdeaStatus.Pending,
  })
  status!: RoadmapIdeaStatus;

  // Groups the idea in the admin queue alongside items' `category`.
  @Column({ type: 'varchar', default: 'members' })
  category!: string;

  // Admin-only annotation, distinct from the member-facing decline copy.
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  // Set when this idea was declined as a duplicate of an existing item.
  @Column({ type: 'uuid', nullable: true })
  duplicateOfItemId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  declineReason!: RoadmapDeclineReason | null;

  // Member-facing explanation shown next to the decline reason label.
  @Column({ type: 'text', nullable: true })
  declineNote!: string | null;

  // Starting seed count; member votes accrue on top via `roadmap_votes`.
  @Column({ type: 'int', default: 0 })
  votes!: number;

  // Null for seeded ideas with no attributed submitter.
  @Column({ type: 'uuid', nullable: true })
  submittedById!: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
