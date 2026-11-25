import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Event } from '../../events/entities/event.entity';
import { User } from '../../users/entities/user.entity';
import { QuizBadgeDefinition } from './quiz-badge-definition.entity';

/**
 * Quiz win badges: one badge attached to one game of one event. Staff attach
 * up to three badges per game for games 1 to 5 (the cap of three lives in the
 * service, under the event lock). Deleting the event deletes its slots through
 * the cascade, staff detaching a badge deletes the row, and a definition in a
 * slot cannot be deleted (`ON DELETE RESTRICT`). A deleted creator account
 * leaves `created_by_id` null, and `created_by_id` is server-only.
 * `UQ_quiz_event_badge_slots_event_game_badge` keeps each badge once per game.
 * The check `CHK_quiz_event_badge_slots_game_number` lives in the migration
 * only. Migration `1840910000000-AddQuizWinBadges`.
 */
@Entity('quiz_event_badge_slots')
@Index(
  'UQ_quiz_event_badge_slots_event_game_badge',
  ['eventId', 'gameNumber', 'badgeDefinitionId'],
  { unique: true },
)
@Index('IDX_quiz_event_badge_slots_badge_definition_id', ['badgeDefinitionId'])
@Index('IDX_quiz_event_badge_slots_created_by_id', ['createdById'], {
  where: '"created_by_id" IS NOT NULL',
})
export class QuizEventBadgeSlot {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_quiz_event_badge_slots',
  })
  id!: string;

  @Column({ type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'FK_quiz_event_badge_slots_event_id',
  })
  event?: Event;

  @Column({ type: 'integer' })
  gameNumber!: number;

  @Column({ type: 'uuid' })
  badgeDefinitionId!: string;

  @ManyToOne(() => QuizBadgeDefinition, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'badge_definition_id',
    foreignKeyConstraintName: 'FK_quiz_event_badge_slots_badge_definition_id',
  })
  badgeDefinition?: QuizBadgeDefinition;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_quiz_event_badge_slots_created_by_id',
  })
  createdBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
