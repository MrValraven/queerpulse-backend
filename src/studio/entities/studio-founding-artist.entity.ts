import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A founding artist (contract 6.4). The badge reads this table for good; the
 * shelf switch on the landing page lives in `studio_landing_settings`.
 */
@Entity('studio_founding_artists')
@Unique('UQ_studio_founding_artists_subprofile', ['subprofileId'])
@Check('CHK_studio_founding_artists_position', '"position" >= 1')
export class StudioFoundingArtist {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_founding_artists',
  })
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_founding_artists_subprofile',
  })
  subprofile?: Subprofile;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'uuid', nullable: true })
  addedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'added_by_id',
    foreignKeyConstraintName: 'FK_studio_founding_artists_added_by',
  })
  addedBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  createdAt!: Date;
}
