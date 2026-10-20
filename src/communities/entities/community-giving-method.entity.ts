import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** What a giving row holds: an outbound https link, or a value to copy. */
export enum CommunityGivingKind {
  Link = 'link',
  Mbway = 'mbway',
  Iban = 'iban',
}

/**
 * One way to support a community, shown on its Support tab and sidebar.
 * Written only by `CommunityGivingService.replaceBySlug` (owner or co-owner),
 * which replaces the community's whole set in one transaction.
 *
 * `value` is stored canonical: the https URL for a link, 9 digits for MB WAY,
 * an uppercase IBAN without spaces. See `community-giving-rules.ts`.
 *
 * Paired migration `1834200000000-AddCommunityGiving`.
 */
@Entity('community_giving_methods')
export class CommunityGivingMethod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_community_giving_methods_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  @Column({
    type: 'enum',
    enum: CommunityGivingKind,
    enumName: 'community_giving_kind',
  })
  kind!: CommunityGivingKind;

  @Column({ type: 'varchar', length: 60, nullable: true })
  label!: string | null;

  @Column({ type: 'varchar', length: 500 })
  value!: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  note!: string | null;

  @Column({ type: 'integer' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
