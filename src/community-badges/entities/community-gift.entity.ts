import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Community } from '../../communities/entities/community.entity';
import { User } from '../../users/entities/user.entity';
import type { CommunityGiftKey } from '../community-badges.catalog';

/**
 * Community gifts: one gift a staff member sent to a member of one community,
 * with an optional short note. Deleting the community or the recipient account
 * deletes it through the cascade; a deleted sender or platform moderator
 * account leaves `sender_id` or `removed_by_id` null. `hidden_by_recipient_at`
 * hides the gift mark from other viewers; `removed_at` records a staff or
 * platform takedown, and `removed_by_id` is server-only.
 * `IDX_community_gifts_community_recipient_sent` serves the recent-gift marks
 * and `IDX_community_gifts_community_sender_sent` the weekly allowance count.
 * Migration `1840700000000-AddCommunityBadges`.
 */
@Entity('community_gifts')
@Index('IDX_community_gifts_community_recipient_sent', [
  'communityId',
  'recipientId',
  'sentAt',
])
@Index('IDX_community_gifts_community_sender_sent', [
  'communityId',
  'senderId',
  'sentAt',
])
@Index('IDX_community_gifts_removed_by_id', ['removedById'], {
  where: '"removed_by_id" IS NOT NULL',
})
export class CommunityGift {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_community_gifts',
  })
  id!: string;

  @Column({ type: 'uuid' })
  communityId!: string;

  @ManyToOne(() => Community, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'community_id',
    foreignKeyConstraintName: 'FK_community_gifts_community',
  })
  community?: Community;

  @Index('IDX_community_gifts_sender_id')
  @Column({ type: 'uuid', nullable: true })
  senderId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'sender_id',
    foreignKeyConstraintName: 'FK_community_gifts_sender',
  })
  sender?: User | null;

  @Index('IDX_community_gifts_recipient_id')
  @Column({ type: 'uuid' })
  recipientId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'recipient_id',
    foreignKeyConstraintName: 'FK_community_gifts_recipient',
  })
  recipient?: User;

  @Column({ type: 'varchar', length: 32 })
  giftKey!: CommunityGiftKey;

  @Column({ type: 'varchar', length: 140, nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  sentAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  hiddenByRecipientAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  removedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'removed_by_id',
    foreignKeyConstraintName: 'FK_community_gifts_removed_by',
  })
  removedBy?: User | null;
}
