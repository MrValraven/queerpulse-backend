import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type FeedEntryStatus = 'pending' | 'published' | 'dismissed';

export const FEED_ENTRY_STATUSES: readonly FeedEntryStatus[] = [
  'pending',
  'published',
  'dismissed',
];

/**
 * One episode a connected feed has offered, keyed by its `guid` within the
 * feed. A sync only ever INSERTS rows for guids it has not seen, so nothing
 * here (or in the items published from it) is overwritten by a later sync.
 *
 * The (feed, status, published_at DESC) read index lives in migration
 * `AddSubprofileFeeds1827800100000` only; the schema is migration-owned.
 */
@Entity('subprofile_feed_entries')
@Unique('UQ_subprofile_feed_entries_feed_guid', ['feedId', 'guid'])
export class SubprofileFeedEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  feedId!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @Column({ type: 'varchar', length: 500 })
  guid!: string;

  @Column({ type: 'varchar', length: 500 })
  title!: string;

  /** Plain text (HTML stripped), at most 2000 characters. */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** The episode's web page, else its enclosure URL. */
  @Column({ type: 'varchar', length: 2048, nullable: true })
  link!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  durationSeconds!: number | null;

  @Column({ type: 'int', nullable: true })
  season!: number | null;

  @Column({ type: 'int', nullable: true })
  episode!: number | null;

  /** The episode art on the podcast host. SERVER-SIDE ONLY: it is downloaded
   *  into our storage on publish and never returned in a response. */
  @Column({ type: 'varchar', length: 2048, nullable: true })
  remoteImageUrl!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: FeedEntryStatus;

  /** The `subprofile_items` row this entry was published as. */
  @Column({ type: 'uuid', nullable: true })
  itemId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
