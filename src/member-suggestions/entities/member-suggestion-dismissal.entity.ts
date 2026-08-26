import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * One row per (member, person) the member has waved away from their people
 * suggestions (SOC-05).
 *
 * WHY THIS EXISTS. A suggestion a member has already declined and keeps being
 * shown stops reading as a suggestion and starts reading as nagging. Without
 * a store the strip would offer the same faces on every feed load forever,
 * because the graph facts behind them do not change when a member says "no
 * thanks".
 *
 * DISMISSING IS NOT BLOCKING, AND IS NOT MUTING. Nothing here reaches
 * `blocks` or `mutes`. The dismissed member keeps every bit of reach they
 * had: they still appear in the directory, in search, in shared communities,
 * in the feed, and they can still be found and messaged. The only thing that
 * changes is whether THIS surface offers them back unprompted. The dismissed
 * person is never told.
 *
 * IT IS ALSO SILENT IN THE OTHER DIRECTION. `dismissed_user_id` is never read
 * from the dismissed member's side, so nobody can learn who has waved them
 * away.
 *
 * Both columns are real user ids with cascading foreign keys: an erased
 * account should take its own dismissals with it, in both directions.
 */
@Entity('member_suggestion_dismissals')
@Unique('UQ_member_suggestion_dismissals', ['userId', 'dismissedUserId'])
export class MemberSuggestionDismissal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The member who dismissed. Every read is scoped to this column. */
  @Index('IDX_member_suggestion_dismissals_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  /** The member who will not be suggested to them again. */
  @Column({ type: 'uuid' })
  dismissedUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
