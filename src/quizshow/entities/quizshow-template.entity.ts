import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * A staff-made Pulse Live quiz that hosts copy once it is published. It owns
 * one quiz through `quizshow_quizzes.template_id`. Deleting it deletes that
 * quiz, and host copies keep their rows with `source_template_id` set null.
 * It has no owner and no event, so account erasure and event deletion never
 * reach it. The publisher column is set null when that account goes. Staff
 * notes stay on the staff routes and are never copied on import.
 */
@Entity('quizshow_templates')
export class QuizshowTemplateRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  cardTitleEn!: string;

  @Column({ type: 'varchar', length: 120 })
  cardTitlePt!: string;

  @Column({ type: 'varchar', length: 300 })
  cardDescriptionEn!: string;

  @Column({ type: 'varchar', length: 300 })
  cardDescriptionPt!: string;

  @Column({ type: 'varchar', length: 20000, default: '' })
  staffNotes!: string;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  publishedByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'published_by_user_id',
    foreignKeyConstraintName: 'FK_quizshow_templates_published_by',
  })
  publishedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
