import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum EventVisibility {
  Public = 'public',
  Members = 'members',
  InviteOnly = 'invite_only',
  // --- gathering audience scope (2026-08-13 design) -------------------------
  // Strict 1st-degree: host + host's accepted connections. See
  // `EventsService.assertCanView` and the browse/search queries.
  Network = 'network',
  // 2nd-degree: the `Network` condition OR a mutual connection between viewer
  // and host. Deliberately excluded from open browse/search (link-only
  // discovery) — see `EventsService.list`/`searchByText`.
  ExtendedNetwork = 'extended_network',
  // Members of the event's own community (`Event.communityId`). Mutually
  // exclusive with the network tiers at the wizard level; the service layer
  // rejects `Community` visibility when no community is set.
  Community = 'community',
}

export enum EventStatus {
  Draft = 'draft',
  Published = 'published',
  Cancelled = 'cancelled',
}

@Entity('events')
@Index('IDX_events_status_start_at', ['status', 'startAt'])
// Scoped to `public`/`members` only. The three scoped tiers added for
// gathering audience scope (network/extended_network/community) fall outside
// this partial index by design: `network`/`community` browse hits are served
// via the OR-in `host_id`/`community_id` predicates in `EventsService.list`
// (not this feed-cursor index), and `extended_network` is link-only and never
// reaches the browse feed at all (see the 2026-08-13 design doc, decision 2b).
// Revisit only if a measurement shows a regression — not changed here.
@Index('IDX_events_feed_created_at_id', ['createdAt', 'id'], {
  where: `"status" = 'published' AND "visibility" IN ('public', 'members')`,
})
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_events_host_id')
  @Column({ type: 'uuid' })
  hostId!: string;

  @Index('UQ_events_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'timestamptz' })
  startAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endAt!: Date | null;

  @Column({ type: 'varchar' })
  timezone!: string;

  @Column({ type: 'varchar', nullable: true })
  venue!: string | null;

  // Optional link to the directory listing (business) hosting this event, so a
  // listing's detail page can show its upcoming events. Free-text `venue` is
  // kept for events not tied to a listed venue; null here means "not at a
  // listed venue".
  @Index('IDX_events_listing_id')
  @Column({ type: 'uuid', nullable: true })
  listingId!: string | null;

  // Optional link to the community this event belongs to, so a community's
  // page can show its upcoming events. Null means the event isn't tied to a
  // specific community.
  @Index('IDX_events_community_id')
  @Column({ type: 'uuid', nullable: true })
  communityId!: string | null;

  @Column({ type: 'boolean', default: false })
  isOnline!: boolean;

  @Column({ type: 'varchar', nullable: true })
  onlineUrl!: string | null;

  @Column({ type: 'int', nullable: true })
  capacity!: number | null;

  @Column({
    type: 'enum',
    enum: EventVisibility,
    enumName: 'events_visibility_enum',
    default: EventVisibility.Public,
  })
  visibility!: EventVisibility;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'events_status_enum',
    default: EventStatus.Draft,
  })
  status!: EventStatus;

  @Column({ type: 'varchar', nullable: true })
  coverImageUrl!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reminderSentAt!: Date | null;

  // ── Manage-dashboard "Options" toggles — see `AddEventOptionsFlags`'s doc
  // for why only these two of the four mock toggles got a real backend field.
  @Column({ type: 'boolean', default: true })
  allowWaitlist!: boolean;

  @Column({ type: 'boolean', default: true })
  showAttendeeCount!: boolean;

  // ── Recurring series (MSG-10) — see `EventSeries`'s class doc. Both null
  // for a standalone (non-repeating) event; both set together, never one
  // without the other.
  @Index('IDX_events_series_id')
  @Column({ type: 'uuid', nullable: true })
  seriesId!: string | null;

  // 0-based position of this occurrence within its series (0 = the first,
  // the one whose own `startAt` the host originally picked).
  @Column({ type: 'int', nullable: true })
  seriesIndex!: number | null;

  // Millisecond precision (not Postgres's microsecond default): matches the
  // resolution of the JS `Date` cursor `cursorPaginate` builds from this
  // column, so the raw column can be ordered/filtered on directly instead of
  // through a non-indexable `date_trunc(...)` wrapper — see
  // `1785001400000-NarrowCursorCreatedAtPrecision.ts` and
  // `common/cursor-pagination.ts`.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
