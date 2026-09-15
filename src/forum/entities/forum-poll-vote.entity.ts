import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One member's pick of one poll OPTION. Modelled on `ForumPostVote`, with one
 * deliberate difference: `ForumPostVote` is unique on `(post_id, user_id)`
 * because a post takes one vote per member, while this table is unique on
 * `(option_id, user_id)` — one row per member per option.
 *
 * That is what makes multi-choice polls work. A member picking three options in
 * an `allowMultiple` poll holds three rows, each independently idempotent (a
 * re-pick hits the unique, an un-pick deletes the row, exactly as
 * `ForumPostVote`'s zero-value toggle does). A single-choice poll is the same
 * table with the service permitting one row; the constraint never has to know
 * which mode the poll is in.
 *
 * No relation decorators — bare `uuid` columns, FKs declared in the migration
 * (`option_id` and `poll_id` `ON DELETE CASCADE` to their parents, `user_id`
 * `ON DELETE CASCADE` to `users`, matching `forum_post_vote`).
 */
@Entity('forum_poll_vote')
@Index('UQ_forum_poll_vote_option_user', ['optionId', 'userId'], {
  unique: true,
})
export class ForumPollVote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Denormalized copy of `forumPollOption.pollId`, carried on the ballot so
  // counting or clearing everything one member has picked in a poll is a single
  // indexed lookup instead of a join through every option of that poll.
  // Migration-owned FK to `forum_poll`, so the copy cannot outlive the poll.
  @Index('IDX_forum_poll_vote_poll_id')
  @Column({ type: 'uuid' })
  pollId!: string;

  // The option picked. No standalone index: the unique index above leads with
  // this column and serves both the option-scoped read and the cascade.
  @Column({ type: 'uuid' })
  optionId!: string;

  @Index('IDX_forum_poll_vote_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  // Millisecond precision, matching the rest of the composer's new tables.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
