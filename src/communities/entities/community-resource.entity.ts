import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * What kind of thing a resource points at, so the shelf can label and icon it
 * without guessing from the URL. `link` is anything on the open web, `doc` is
 * a document the community keeps (a constitution, a budget, a meeting record),
 * `guide` is a how-to the community wrote for its own people.
 */
export enum CommunityResourceKind {
  Link = 'link',
  Doc = 'doc',
  Guide = 'guide',
}

/**
 * One entry on a community's resource shelf: the pinned links, documents and
 * guides an owner wants every member to be able to find without scrolling the
 * post feed. Communities were losing this to pinned posts, which sink.
 *
 * Owner-curated, so ordering is deliberate (`position`) rather than
 * chronological, and there is no member-submission path in this table's
 * contract: rows are written by owner/mod endpoints.
 *
 * Paired migration `1793840000000-AddCommunityResources`.
 */
@Entity('community_resources')
export class CommunityResource {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // CASCADE on the community: the shelf has no meaning without the room.
  // Indexed because every read of this table is "the shelf for one community".
  @Index('IDX_community_resources_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  @Column({ type: 'varchar' })
  title!: string;

  // Validated and length-capped at the DTO layer. Stored as the raw absolute
  // URL the owner entered, resolved by nobody: this is an outbound link, so
  // unlike `Community.coverImageUrl` there is no storage-key convention here.
  @Column({ type: 'varchar' })
  url!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({
    type: 'enum',
    enum: CommunityResourceKind,
    enumName: 'community_resources_kind_enum',
  })
  kind!: CommunityResourceKind;

  // The owner's chosen order on the shelf, ascending. Defaults to 0 so a row
  // inserted without an explicit position lands at the top of the shelf and is
  // visible enough to be reordered, instead of disappearing off the bottom.
  // Ties broken by `createdAt` at the read site.
  @Column({ type: 'integer', default: 0 })
  position!: number;

  // Nullable and `ON DELETE SET NULL` for account erasure, the actor-FK
  // convention this module follows: an owner leaving the platform must not
  // take the community's shelf with them.
  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
