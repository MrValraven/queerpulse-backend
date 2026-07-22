import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Whether the member wants a place (`seeking`) or has a room to fill
 * (`offering`). Mirrors the frontend's flatmate board type toggle. */
export enum FlatmateProfileType {
  Seeking = 'seeking',
  Offering = 'offering',
}

/**
 * A member's flatmate profile. One per member (unique `ownerId`), published
 * immediately (no moderation status). Identity (name/avatar/member slug) is NOT
 * stored — it is hydrated from the member's `Profile` via `MemberLookup`.
 */
@Entity('flatmate_profiles')
export class FlatmateProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_flatmate_profiles_owner_id', { unique: true })
  @Column({ type: 'uuid' })
  ownerId: string;

  @Index('UQ_flatmate_profiles_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Index('IDX_flatmate_profiles_type')
  @Column({
    type: 'enum',
    enum: FlatmateProfileType,
    enumName: 'flatmate_profiles_type_enum',
  })
  type: FlatmateProfileType;

  @Column({ type: 'varchar', length: 60, default: '' })
  pronouns: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  neighbourhood: string;

  // Seeker's max budget / offering's room rent (euros). Used for both the
  // budget filter and match scoring.
  @Column({ type: 'int' })
  budgetEuros: number;

  @Column({ type: 'date', nullable: true })
  moveInFrom: string | null;

  @Column({ type: 'boolean', default: false })
  flexibleTiming: boolean;

  @Column({ type: 'text', default: '' })
  about: string;

  @Column({ type: 'text', array: true, default: '{}' })
  lifestyleTags: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
