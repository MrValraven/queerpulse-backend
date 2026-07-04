import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { CinemaTitle } from './cinema-title.entity';

@Entity('cinema_watch_progress')
@Unique('UQ_cinema_watch_progress_user_title', ['userId', 'titleId'])
export class WatchProgress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  titleId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => CinemaTitle, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'title_id' })
  title: CinemaTitle;

  @Column({ type: 'integer' })
  positionSeconds: number;

  // Set exactly once, when this user's first progress report crosses the
  // view threshold — the NULL guard makes view counting idempotent.
  @Column({ type: 'timestamptz', nullable: true })
  viewCountedAt: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
