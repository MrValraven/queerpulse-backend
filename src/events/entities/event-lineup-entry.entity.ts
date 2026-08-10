import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// A host-tagged "who performed" credit on an event — one row per (event,
// member). Backs `PUT/GET /events/:slug/lineup` (Personas Phase 5, Moment 5:
// the post-gathering persona nudge). `role` is a free-ish craft/role label
// the host assigns ("dj"/"chef"/"performing"/...) — deliberately NOT an enum
// or FK to `SubprofileKind`, since a host may tag someone whose craft isn't
// (yet) a recognised persona kind. `UQ_event_lineup_entries (event_id,
// user_id)` makes a replace-all write idempotent per member and mirrors
// `event_cohosts`/`event_bookmarks`'s composite-unique shape.
@Entity('event_lineup_entries')
@Unique('UQ_event_lineup_entries', ['eventId', 'userId'])
export class EventLineupEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_event_lineup_entries_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 40 })
  role!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
