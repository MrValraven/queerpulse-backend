import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum CommunityType {
  Social = 'social',
  Arts = 'arts',
  Activism = 'activism',
  Support = 'support',
  Sports = 'sports',
  Professional = 'professional',
}

export enum AccessTier {
  Public = 'public',
  Request = 'request',
  Invite = 'invite',
  Private = 'private',
}

@Entity('communities')
export class Community {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_communities_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text' })
  purpose!: string;

  @Column({
    type: 'enum',
    enum: CommunityType,
    enumName: 'communities_type_enum',
  })
  type!: CommunityType;

  @Column({ type: 'text' })
  whoFor!: string;

  @Column({ type: 'varchar' })
  tagline!: string;

  @Column({
    type: 'enum',
    enum: AccessTier,
    enumName: 'communities_access_tier_enum',
  })
  accessTier!: AccessTier;

  @Column({ type: 'boolean', default: true })
  rosterVisible!: boolean;

  @Column({ type: 'text', array: true, default: '{}' })
  features!: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  rules!: string[];

  @Index('IDX_communities_owner_id')
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Index('UQ_communities_ref', { unique: true })
  @Column({ type: 'varchar' })
  ref!: string;

  // Indexed so `AdminCommunitiesService.listCommunities`'s `ORDER BY
  // created_at ASC ... LIMIT` (see `1785700200000-AddCommunitiesCreatedAtIndex`)
  // can be served by an `Index Scan ... Limit` instead of a full-table
  // `Seq Scan` + `Sort`.
  @Index('IDX_communities_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // Set when an owner archives the community from the mod panel's danger zone.
  // A non-null value takes the community down for everyone but its own
  // owner/mods (mirrors the moderation-takedown posture in
  // `CommunitiesService.getBySlug`) and hides it from every listing. Nullable
  // (never archived by default); the paired UNAPPLIED migration is
  // `1785800600000-AddCommunityArchivedAt`.
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;
}
