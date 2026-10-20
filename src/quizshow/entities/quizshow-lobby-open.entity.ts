import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * One lobby a member opened, events and games together. The lobby rate
 * limit counts these rows, so the count outlives a deleted game and its
 * sessions. No key to quizzes or sessions on purpose.
 * Retention: the opener's rows older than one hour are deleted on each open,
 * and every row goes with the member's account.
 */
@Entity('quizshow_lobby_opens')
@Index('IDX_quizshow_lobby_opens_user_opened', ['userId', 'openedAt'])
export class QuizshowLobbyOpenRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_quizshow_lobby_opens_user',
  })
  user?: User;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  openedAt!: Date;
}
