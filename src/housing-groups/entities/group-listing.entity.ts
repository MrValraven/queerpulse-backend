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
import { HousingGroup } from './housing-group.entity';

/**
 * A housing listing shared inside a group. The group's norms are enforced as
 * product rules on this row: price transparency (`priceEuros`) and
 * accessibility information (`accessibilityInfo`) are NOT NULL and required by
 * the create DTO — a listing physically cannot exist without them. A moderator
 * can hide a listing that violates a norm (`hidden` + `hiddenReason`) rather
 * than hard-deleting it, keeping an audit trail.
 */
@Entity('group_listings')
export class GroupListing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_group_listings_group_id')
  @Column({ type: 'uuid' })
  groupId!: string;

  @ManyToOne(() => HousingGroup, (group) => group.listings, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'group_id' })
  group!: HousingGroup;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'varchar' })
  neighbourhood!: string;

  /** Required price transparency (monthly rent in euros) — a group norm. */
  @Column({ type: 'int' })
  priceEuros!: number;

  /** Required accessibility information — a group norm (never nullable). */
  @Column({ type: 'text' })
  accessibilityInfo!: string;

  /** Hidden by a moderator for a norm violation (hate speech, broker, etc.). */
  @Column({ type: 'boolean', default: false })
  hidden!: boolean;

  @Column({ type: 'text', nullable: true })
  hiddenReason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
