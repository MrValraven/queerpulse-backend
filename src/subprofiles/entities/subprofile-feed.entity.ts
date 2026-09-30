import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { SubprofileSection } from './subprofile-item.entity';

/** Why the last check of a feed failed. Also the `code` of the 422 a preview or
 *  connect answers when the feed cannot be read. */
export type FeedErrorCode =
  'unreachable' | 'timeout' | 'http_error' | 'too_large' | 'not_a_feed';

/**
 * A podcast RSS feed connected to a persona (persona feed import). The
 * scheduler (`SubprofileFeedSyncService`) re-checks it every few hours and
 * records each episode it has not seen before in `subprofile_feed_entries`.
 * See migration `AddSubprofileFeeds1827800100000`.
 */
@Entity('subprofile_feeds')
@Unique('UQ_subprofile_feeds_subprofile_feed_url', ['subprofileId', 'feedUrl'])
export class SubprofileFeed {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  /** The member who connected the feed. Scheduled auto-publishing acts as
   *  them, and only while they are still a member of the persona. Null once
   *  their account is erased (`ON DELETE SET NULL`). */
  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  /** The feed URL after redirects, as resolved when it was connected. */
  @Column({ type: 'varchar', length: 2048 })
  feedUrl!: string;

  /** The section published episodes land in. */
  @Column({
    type: 'enum',
    enum: SubprofileSection,
    enumName: 'subprofile_items_section_enum',
  })
  section!: SubprofileSection;

  /** `<channel><title>`, plain text. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  title!: string | null;

  /** `<itunes:author>`, plain text. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  author!: string | null;

  /** Storage key of OUR copy of the show art (a `work-image` key). The remote
   *  art is never stored or hotlinked. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  imageKey!: string | null;

  @Column({ type: 'boolean', default: false })
  autoPublish!: boolean;

  /** Validators for the next conditional GET. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  etag!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastModified!: string | null;

  /** Last successful fetch (a 304 counts). */
  @Column({ type: 'timestamptz', nullable: true })
  lastSyncedAt!: Date | null;

  /** Last fetch attempt, successful or not. Rate-limits the manual sync. */
  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  @Index('IDX_subprofile_feeds_next_check_at')
  @Column({ type: 'timestamptz' })
  nextCheckAt!: Date;

  @Column({ type: 'int', default: 0 })
  consecutiveFailures!: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  lastError!: FeedErrorCode | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
