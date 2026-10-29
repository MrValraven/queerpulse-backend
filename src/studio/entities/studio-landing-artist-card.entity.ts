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
 * An artist card on the Studio page (contract 6.2): one persona with an
 * optional quote, in a staff-set order. Staff tick that the person agreed to
 * appear; the check refuses a row saved without that tick, and `consentedAt`
 * is restamped on every save.
 */
@Entity('studio_landing_artist_cards')
@Unique('UQ_studio_landing_artist_cards_subprofile', ['subprofileId'])
@Check('CHK_studio_landing_artist_cards_position', '"position" >= 1')
@Check('CHK_studio_landing_artist_cards_consent', '"has_consent"')
export class StudioLandingArtistCard {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_landing_artist_cards',
  })
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_landing_artist_cards_subprofile',
  })
  subprofile?: Subprofile;

  @Column({ type: 'varchar', length: 240, nullable: true })
  quote!: string | null;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'boolean' })
  hasConsent!: boolean;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  consentedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_studio_landing_artist_cards_created_by',
  })
  createdBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  updatedAt!: Date;
}
