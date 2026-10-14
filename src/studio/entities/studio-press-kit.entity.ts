import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';

/** One press quote as stored in `studio_press_kits.quotes`. */
export interface StudioPressQuoteValue {
  quote: string;
  source: string;
}

/**
 * Studio v3: a persona's press kit, one row per persona. With no row the
 * press kit is built from the persona alone. `featured_track_ids` keeps the
 * chosen order; readers keep only tracks that are still playable. The
 * persona foreign key cascades on update (unlink re-key) and on delete.
 * Migration `1832000100000-AddStudioArtistTools`.
 */
@Entity('studio_press_kits')
@Check(
  'CHK_studio_press_kits_featured_track_ids',
  `cardinality("featured_track_ids") <= 5`,
)
@Check(
  'CHK_studio_press_kits_press_bio',
  `"press_bio" IS NULL OR char_length("press_bio") <= 1500`,
)
export class StudioPressKit {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_studio_press_kits',
  })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_press_kits_subprofile',
  })
  subprofile?: Subprofile;

  @Column({ type: 'varchar', length: 140, nullable: true })
  pitch!: string | null;

  @Column({ type: 'text', nullable: true })
  pressBio!: string | null;

  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  featuredTrackIds!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  quotes!: StudioPressQuoteValue[];

  @Column({ type: 'varchar', length: 1000, nullable: true })
  contact!: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
