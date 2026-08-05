import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum LandingSection {
  Member = 'member',
  Community = 'community',
  Changemaker = 'changemaker',
}

export type LandingCopy =
  | { quote: string }
  | { blurb?: string }
  | { cause: string; blurb: string; tags?: string[] };

/**
 * An admin-curated feature slot on the live landing page — a member quote, a
 * community blurb, or a changemaker highlight. `targetId` points at the
 * featured entity's id (its meaning depends on `section`); `copy` is the
 * admin-authored text shown alongside it, shape-validated per section by
 * `validateLandingCopy`.
 */
@Entity('landing_feature')
@Index('IDX_landing_feature_section_active_position', [
  'section',
  'active',
  'position',
])
@Index('UQ_landing_feature_section_target', ['section', 'targetId'], {
  unique: true,
})
export class LandingFeature {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  section!: LandingSection;

  @Column({ type: 'uuid' })
  targetId!: string;

  @Column({ type: 'int', default: 0 })
  position!: number;

  @Column({ type: 'jsonb' })
  copy!: LandingCopy;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
