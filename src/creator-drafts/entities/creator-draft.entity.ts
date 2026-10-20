import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Community } from '../../communities/entities/community.entity';
import { Listing } from '../../listings/entities/listing.entity';
import { User } from '../../users/entities/user.entity';
import {
  STORED_CREATOR_DRAFT_KINDS,
  type StoredCreatorDraftKind,
} from '../creator-drafts.constants';

/**
 * One creator draft: the event wizard, a listing edit or Start a Community,
 * one row per author per kind and slot. The author is the only reader and
 * writer; staff read through the allow-lists in `creator-draft-public-fields`.
 * The payload is owned by the frontend and is never logged.
 *
 * The list index `IDX_creator_drafts_kind_updated_at` (kind, updated_at DESC,
 * id DESC) lives in the migration only.
 */
@Entity('creator_drafts')
@Index('UQ_creator_drafts_user_kind_slot', ['userId', 'kind', 'slotKey'], {
  unique: true,
})
@Index('IDX_creator_drafts_updated_at', ['updatedAt'])
export class CreatorDraft {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    type: 'enum',
    enum: STORED_CREATOR_DRAFT_KINDS,
    enumName: 'creator_drafts_kind_enum',
  })
  kind!: StoredCreatorDraftKind;

  @Column({ type: 'varchar', length: 64, default: '' })
  slotKey!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'int' })
  payloadVersion!: number;

  @Column({ type: 'int', default: 1 })
  revision!: number;

  @Column({ type: 'uuid', nullable: true })
  madeForCommunityId!: string | null;

  @ManyToOne(() => Community, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'made_for_community_id' })
  madeForCommunity!: Community | null;

  @Column({ type: 'uuid', nullable: true })
  madeForListingId!: string | null;

  @ManyToOne(() => Listing, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'made_for_listing_id' })
  madeForListing!: Listing | null;

  @Column({ type: 'int', nullable: true })
  progressDone!: number | null;

  @Column({ type: 'int', nullable: true })
  progressTotal!: number | null;

  @Column({ type: 'text', array: true, nullable: true })
  missing!: string[] | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt!: Date;
}
