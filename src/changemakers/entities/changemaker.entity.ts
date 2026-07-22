import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ChangemakerStatus {
  Draft = 'draft',
  Published = 'published',
}

export type ChangemakerTint = 'coral' | 'jade' | 'plum';

/**
 * A curated Change Makers directory profile — the server-backed replacement
 * for the static `CHANGEMAKERS` array in
 * `queerpulse/src/features/community/changemakerStories.*.data`. Holds both the
 * card fields and the long-form story article. `readTime` and the display
 * `date` are NOT stored — the frontend adapter derives them from `body` and
 * `publishedAt`.
 */
@Entity('changemaker')
export class Changemaker {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_changemaker_slug', { unique: true })
  @Column({ type: 'varchar', length: 200 })
  slug: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 12 })
  initials: string;

  @Column({ type: 'varchar', length: 120 })
  cause: string;

  @Column({ type: 'varchar', length: 12, default: 'plum' })
  tint: ChangemakerTint;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags: string[];

  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  impact: string[];

  @Column({ type: 'varchar', length: 200, default: '' })
  byline: string;

  @Column({ type: 'varchar', length: 300, default: '' })
  heroNote: string;

  @Column({ type: 'text', default: '' })
  lead: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  body: string[];

  @Column({ type: 'text', default: '' })
  pullQuoteText: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  pullQuoteCite: string;

  @Index('IDX_changemaker_status')
  @Column({ type: 'varchar', length: 20, default: ChangemakerStatus.Draft })
  status: ChangemakerStatus;

  @Column({ type: 'boolean', default: false })
  isFeatured: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
