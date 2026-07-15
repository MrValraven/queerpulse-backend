import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One member's vote on one post. `POST /forum/posts/:id/vote` only ever
 * sends `value` 0 or 1 (an upvote toggle, no downvote) — a `value: 0` vote
 * is *deleted*, not stored, so every row that exists has `value = 1`. The
 * `value` column is kept (rather than the row's mere existence standing in
 * for it) because the task brief names it explicitly and it keeps the door
 * open for a richer vote scale later without a schema change.
 */
@Entity('forum_post_vote')
@Index('UQ_forum_post_vote', ['postId', 'userId'], { unique: true })
export class ForumPostVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  postId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'smallint' })
  value: number;
}
