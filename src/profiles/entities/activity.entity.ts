import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum ActivityKind {
  Post = 'post',
  Event = 'event',
  Message = 'message',
  Reading = 'reading',
  Edit = 'edit',
  Photo = 'photo',
  Music = 'music',
  // A member joined a PUBLIC community. See `ActivityListener`.
  Community = 'community',
  // A member published a persona (subprofile) that is public. See
  // `ActivityListener`.
  Persona = 'persona',
}

/**
 * What an activity row is ABOUT, so the row's continued visibility can be
 * re-checked at read time.
 *
 * The write-time gate in `ActivityListener` records a row only when its
 * subject is public at that instant, but a subject can go private afterwards:
 * a public event switched to members-only, a public community switched to
 * request-to-join, a published persona unpublished. Without a stored subject
 * reference the row would keep asserting a fact that is no longer public.
 * `ActivityVisibilityService` reads this pair, batches one lookup per kind, and
 * drops (and purges) any row whose subject has stopped being public.
 *
 * A forum thread is one of those subjects: it can be withdrawn, sit behind a
 * schedule or a review, live in a community that turns private, or be posted
 * anonymously or under the QueerPulse byline, and each of those must take the
 * "started a thread" row with it. Its subject id is the thread slug.
 *
 * `null` is what every row written before this column existed carries, and
 * those rows keep their original behaviour exactly: shown and left unchecked.
 * Forum rows written before `forum_thread` joined this enum are moved onto it
 * by `1823800200000-BackfillForumThreadActivitySubjects`.
 */
export enum ActivitySubjectKind {
  Event = 'event',
  Community = 'community',
  Persona = 'persona',
  ForumThread = 'forum_thread',
}

@Entity('activities')
// The purge path (`ActivityVisibilityService`) deletes every row pointing at
// one subject that has stopped being public, across all members at once, so
// the lookup is keyed by (kind, id).
@Index('IDX_activities_subject', ['subjectKind', 'subjectId'])
export class Activity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_activities_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: ActivityKind,
    enumName: 'activities_kind_enum',
  })
  kind!: ActivityKind;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar', nullable: true })
  sub!: string | null;

  @Column({ type: 'varchar', nullable: true })
  toLink!: string | null;

  // See ActivitySubjectKind. Null = nothing to re-check (a row written before
  // these columns existed).
  @Column({
    type: 'enum',
    enum: ActivitySubjectKind,
    enumName: 'activities_subject_kind_enum',
    nullable: true,
  })
  subjectKind!: ActivitySubjectKind | null;

  // The subject's stable public identifier: an event slug, a community slug,
  // a forum thread slug, or a persona's uuid. Deliberately a varchar so slugs
  // and uuids share one column.
  @Column({ type: 'varchar', nullable: true })
  subjectId!: string | null;

  @Column({ type: 'timestamptz' })
  occurredAt!: Date;
}
