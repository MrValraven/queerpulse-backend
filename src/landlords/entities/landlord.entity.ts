import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Moderation lifecycle. A member-suggested entry starts `review`; a
 * moderator/admin flips it to `live`. Admin-created entries start `live`. */
export enum LandlordStatus {
  Review = 'review',
  Live = 'live',
}

/** One editorial stat chip on the detail page (e.g. "15+ years"). */
export interface LandlordStat {
  value: string;
  label: string;
}

/**
 * A community-maintained landlord directory entry (a third party — no member
 * owns it). Recommendations and intro requests live in sibling tables, queried
 * by `landlordId` (entities are relation-free). Aggregate rating is computed on
 * read from recommendations, not stored.
 */
@Entity('landlords')
export class Landlord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_landlords_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Index('IDX_landlords_status')
  @Column({
    type: 'enum',
    enum: LandlordStatus,
    enumName: 'landlords_status_enum',
    default: LandlordStatus.Review,
  })
  status: LandlordStatus;

  // The member who suggested the entry (null for admin-created). Nullable +
  // ON DELETE SET NULL so erasing that member preserves the community entry.
  @Index('IDX_landlords_submitted_by_user_id')
  @Column({ type: 'uuid', nullable: true })
  submittedByUserId: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  hood: string;

  @Column({ type: 'varchar', default: '' })
  photo: string;

  @Column({ type: 'varchar', default: '' })
  tagline: string;

  @Column({ type: 'varchar', default: '' })
  note: string;

  @Column({ type: 'text', array: true, default: '{}' })
  about: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  areas: string[];

  @Column({ type: 'text', default: '' })
  rentingNote: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  stats: LandlordStat[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
