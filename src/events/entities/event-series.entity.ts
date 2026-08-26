import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum EventSeriesCadence {
  Weekly = 'weekly',
  Biweekly = 'biweekly',
  Monthly = 'monthly',
}

export enum EventSeriesEndType {
  Count = 'count',
  Date = 'date',
}

/**
 * A recurring gathering's repeat rule (MSG-10 — "recurring events"). One row
 * per series; every occurrence is a fully independent `Event` row
 * (`Event.seriesId` + `Event.seriesIndex`, 0-based) generated up front at
 * series-create time — see `EventsService.create`'s occurrence-generation
 * doc. Deliberately NOT an RFC5545/RRULE engine and NOT a lazy generation
 * job: a fixed cadence, one of two end conditions, and every occurrence
 * materialized as a real row the moment the series is created (capped at
 * `MAX_OCCURRENCES`). `occurrenceCount` is that final, actual number of
 * `Event` rows — read-only history, never recomputed live.
 */
@Entity('event_series')
export class EventSeries {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Nullable since `SetNullContentAuthorFksOnUserErasure1794610000000`: the FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account
  // deleted the whole repeat rule, and with it every occurrence that
  // still pointed at it. It is now `ON DELETE SET NULL`, so
  // NULL here means "the series host's account was erased" rather than "no such row".
  // Read paths must render a removed-member placeholder instead of assuming
  // a non-null id. See `ContentOwnerErasureService` for what happens to the
  // row itself when the account goes.
  @Index('IDX_event_series_host_id')
  @Column({ type: 'uuid', nullable: true })
  hostId!: string | null;

  @Column({
    type: 'enum',
    enum: EventSeriesCadence,
    enumName: 'event_series_cadence_enum',
  })
  cadence!: EventSeriesCadence;

  @Column({
    type: 'enum',
    enum: EventSeriesEndType,
    enumName: 'event_series_end_type_enum',
  })
  endType!: EventSeriesEndType;

  // Set (and read-only thereafter) only when `endType === 'count'`.
  @Column({ type: 'int', nullable: true })
  endCount!: number | null;

  // Set (and read-only thereafter) only when `endType === 'date'`.
  @Column({ type: 'timestamptz', nullable: true })
  endUntil!: Date | null;

  // The actual number of `Event` occurrences generated for this series at
  // create time — see the class doc. Powers `EventSeriesView.occurrenceCount`
  // (event-response.ts) without a second COUNT query per page.
  @Column({ type: 'int' })
  occurrenceCount!: number;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
