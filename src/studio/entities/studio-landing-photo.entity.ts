import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  STUDIO_LANDING_PHOTO_SLOTS,
  StudioLandingPhotoSlot,
} from '../studio.constants';

/**
 * A photo slot on the Studio page (contract 6.3): `hero` or `manifesto`. The
 * image key is landing-scoped (contract 8) and names nobody. Staff tick that
 * the people shown agreed; the check refuses a row saved without that tick,
 * and `consentedAt` is restamped on every save.
 */
@Entity('studio_landing_photos')
@Check('CHK_studio_landing_photos_consent', '"has_consent"')
export class StudioLandingPhoto {
  @PrimaryColumn({
    type: 'enum',
    enum: STUDIO_LANDING_PHOTO_SLOTS,
    enumName: 'studio_landing_photos_slot_enum',
    primaryKeyConstraintName: 'PK_studio_landing_photos',
  })
  slot!: StudioLandingPhotoSlot;

  @Column({ type: 'varchar' })
  imageKey!: string;

  @Column({ type: 'varchar', length: 200 })
  altTextEn!: string;

  @Column({ type: 'varchar', length: 200 })
  altTextPt!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  credit!: string | null;

  @Column({ type: 'boolean' })
  hasConsent!: boolean;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  consentedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'updated_by_id',
    foreignKeyConstraintName: 'FK_studio_landing_photos_updated_by',
  })
  updatedBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  updatedAt!: Date;
}
