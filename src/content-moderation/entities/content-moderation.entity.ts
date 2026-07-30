import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The moderation-visibility state of one piece of content, keyed polymorphically
 * by `(subjectType, subjectId)` — the exact same pair a {@link Report} carries.
 *
 * This is a shared state table on purpose, rather than per-entity
 * `hidden_at`/`removed_at` columns spread across the ~15 content tables the
 * report taxonomy can target (forum posts, community posts/replies, events,
 * listings, businesses, communities, …). A moderator's `hide_content` /
 * `remove_content` action writes exactly one row here (in the same transaction
 * as the report status + audit log), and each content service's read path
 * consults it. Keeping the state OUT of the content rows also keeps a moderator
 * takedown cleanly distinct from an author's own soft-delete/tombstone — the
 * two are reversed by different actors through different routes (a member can
 * restore their own tombstone; only a moderator/appeal can lift a takedown).
 *
 * `subjectType`/`subjectId` are stored as `varchar` (not the
 * `reports_subject_type_enum`) so this table stays decoupled from the reports
 * enum's lifecycle and can key any current or future content type without a
 * follow-up enum migration. `subjectId` is a slug for slug-addressed content
 * (listings, communities, events-by-slug are still keyed by their uuid here),
 * a uuid for id-addressed content (forum/community posts + replies), matching
 * whatever the originating report stored.
 */
@Entity('content_moderation')
@Index('UQ_content_moderation_subject', ['subjectType', 'subjectId'], {
  unique: true,
})
export class ContentModeration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  subjectType: string;

  @Column({ type: 'varchar' })
  subjectId: string;

  // Set by `hide_content` (or the hidden side of `remove_content`). A hidden
  // item is withheld from public/member read paths but is NOT tombstoned —
  // reversing it restores the original content untouched.
  @Column({ type: 'timestamptz', nullable: true })
  hiddenAt: Date | null;

  // Set by `remove_content`. A removed item is a tombstone: read paths that
  // already tombstone (forum/community) render it "[removed]"; others withhold
  // it entirely.
  @Column({ type: 'timestamptz', nullable: true })
  removedAt: Date | null;

  // The moderator who last changed this state. `uuid` with no FK, mirroring
  // `listing_reviews.reviewer_id` / `mod_audit_log.actor_id`: a snapshot
  // identity reference, not a relationship an erasure sweep cascades through.
  @Column({ type: 'uuid', nullable: true })
  moderatedBy: string | null;

  // The report the action was taken against, when there was one (bulk/queue
  // actions always have one). Snapshot reference, no FK.
  @Column({ type: 'uuid', nullable: true })
  reportId: string | null;

  @Column({ type: 'varchar', nullable: true })
  reasonCode: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
