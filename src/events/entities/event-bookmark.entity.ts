import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// A member "saving"/bookmarking an event for later — one row per (user, event).
// Backs the `GET /events?filter=saved` list and the `isBookmarked` flag on event
// summaries/detail. `UQ_event_bookmarks (user_id, event_id)` makes bookmarking
// idempotent at the DB level, so a double-tap just re-affirms the same row via
// `ON CONFLICT DO NOTHING` rather than raising. The composite unique also serves
// the "is THIS user's set of events bookmarked?" batch lookup (`user_id`
// leading), so no separate single-column index is added for it.
@Entity('event_bookmarks')
@Unique('UQ_event_bookmarks', ['userId', 'eventId'])
export class EventBookmark {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_event_bookmarks_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
