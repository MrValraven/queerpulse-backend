import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum RoadmapColumn {
  Shipped = 'shipped',
  Building = 'building',
  Planned = 'planned',
}

/**
 * One roadmap card — shipped, building, or planned — backing
 * `GET /roadmap` and rendered by the `/about/roadmap` page's three columns.
 * Mirrors the frontend's `ShippedItem`/`BuildingItem`/`PlannedItem` shapes in
 * `queerpulse/src/features/marketing/roadmap.data.ts`, merged into one table
 * keyed by `column` rather than three separate ones, since the fields mostly
 * overlap and a card never moves shape when it moves column (shipped uses
 * `date`; building uses `stage`/`eta`/`progress`; planned uses `votes`/`hot`
 * — the unused fields for a given column stay `null`).
 */
@Entity('roadmap_items')
@Index('IDX_roadmap_items_column_sort', ['column', 'sortOrder'])
export class RoadmapItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: RoadmapColumn })
  column: RoadmapColumn;

  @Column()
  category: string;

  @Column()
  name: string;

  @Column({ type: 'text' })
  description: string;

  // Shipped only, e.g. "May 2026".
  @Column({ type: 'varchar', nullable: true })
  date: string | null;

  // Building only, e.g. "In progress".
  @Column({ type: 'varchar', nullable: true })
  stage: string | null;

  // Building only, e.g. "~Q3 2026".
  @Column({ type: 'varchar', nullable: true })
  eta: string | null;

  // Building only, 0-100.
  @Column({ type: 'int', nullable: true })
  progress: number | null;

  // Planned only. Starting seed count; member votes accrue on top via
  // `roadmap_votes`.
  @Column({ type: 'int', default: 0 })
  votes: number;

  @Column({ default: false })
  requested: boolean;

  // Planned only — flags the "🔥 Hot" badge.
  @Column({ default: false })
  hot: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
