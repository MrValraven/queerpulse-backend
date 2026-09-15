import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One answer a member can pick in a `ForumPoll`. Ordering is the author's, held
 * in `position` rather than left to insertion order, so an option added or
 * reworded later does not reshuffle the ballot underneath the people who
 * already voted.
 *
 * No relation decorators — bare `uuid` columns, with the FK
 * (`FK_forum_poll_option_poll_id`, `ON DELETE CASCADE`) declared in the
 * migration.
 */
@Entity('forum_poll_option')
@Index('UQ_forum_poll_option_poll_position', ['pollId', 'position'], {
  unique: true,
})
export class ForumPollOption {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Owning poll. No standalone index on this column: the unique index above
  // leads with it, so it already serves every poll-scoped option read and the
  // cascade's referencing-row search — a second index would be a duplicate of
  // the same leading column, paid for on every write.
  @Column({ type: 'uuid' })
  pollId!: string;

  @Column({ type: 'varchar', length: 60 })
  label!: string;

  // The author's display order, 0-based. Unique per poll (see the index above)
  // so two options cannot claim the same slot and leave the render tie-broken
  // on a uuid — the same failure the `top` sort had before
  // `AddForumThreadTopKeysetAndReplySearch1801010000000`.
  @Column({ type: 'smallint' })
  position!: number;

  // Denormalized count of `forum_poll_vote` rows pointing at this option, kept
  // in sync by the vote path. Same denormalization as `ForumPost.voteCount` and
  // `ForumThread.opVoteCount`, for the same reason: the result bars render on
  // every view of the poll and must not cost a `COUNT(*)` per option.
  @Column({ type: 'int', default: 0 })
  voteCount!: number;
}
