import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One admin-curated press-coverage entry shown on the public
 * `/about/press-kit` page — a headline about QueerPulse in an outside
 * publication. Ordered by `position` and filtered to `active` on the public
 * read; the admin surface sees every row (active AND inactive).
 */
@Entity('press_coverage')
@Index('IDX_press_coverage_active_position', ['active', 'position'])
export class PressCoverage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  source!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar' })
  meta!: string;

  // Free-text publication date shown on the press page, e.g. "4 Mar 2026",
  // "Dec 2024", "Winter Annual". Press coverage dates are irregular (many have
  // no precise day) and the list is admin-ordered by `position`, not sorted by
  // date, so a plain string is the honest fit rather than a Postgres `date`.
  @Column({ type: 'varchar' })
  publishedOn!: string;

  @Column({ type: 'varchar', nullable: true })
  url!: string | null;

  @Column({ type: 'int', default: 0 })
  position!: number;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
