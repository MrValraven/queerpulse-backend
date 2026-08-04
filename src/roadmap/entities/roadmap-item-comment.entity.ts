import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An internal admin note/comment thread on a roadmap item, rendered in the
 * item drawer's Comments section. No FK to `roadmap_items` here — the
 * relationship is declared in the migration (Task A2); this entity only
 * carries the plain `itemId` column, matching how `roadmap-vote.entity.ts`
 * models polymorphic/owned refs. `authorId` is null for system-authored
 * comments, in which case `authorLabel` still carries a display name.
 */
@Entity('roadmap_item_comments')
export class RoadmapItemComment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  itemId!: string;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @Column()
  authorLabel!: string;

  @Column({ type: 'text' })
  body!: string;

  // Soft-hide from the drawer without deleting the audit trail.
  @Column({ default: false })
  hidden!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
