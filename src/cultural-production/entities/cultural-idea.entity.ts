import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  DEFAULT_CULTURAL_IDEA_STATUS,
  type CulturalEventType,
  type CulturalIdeaStatus,
} from '../cultural-production.constants';

/**
 * Cultural Production: one event idea staff put forward at
 * `admin/cultural-production`. A staff-only table: every field stays on the
 * `admin/cultural-production` routes and none reaches a member surface.
 *
 * The decorator lists the columns of `IDX_cultural_ideas_created_at`
 * (`created_at`, `id`) and the migration holds their DESC order, since the
 * decorator API cannot express it. A deleted account leaves its ideas with no
 * author. Migration `1840600000000-AddCulturalProduction`.
 */
@Entity('cultural_ideas')
@Index('IDX_cultural_ideas_created_at', ['createdAt', 'id'])
@Index('IDX_cultural_ideas_author_id', ['authorId'], {
  where: '"author_id" IS NOT NULL',
})
@Check('CHK_cultural_ideas_title', `char_length(btrim("title")) >= 1`)
@Check('CHK_cultural_ideas_description', `char_length("description") <= 4000`)
@Check(
  'CHK_cultural_ideas_event_type',
  `"event_type" IN ('board_game_night', 'quiz_night', 'music_night', 'film_night', 'workshop', 'talk', 'party', 'other')`,
)
@Check(
  'CHK_cultural_ideas_status',
  `"status" IN ('new', 'exploring', 'planned', 'parked')`,
)
export class CulturalIdea {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_cultural_ideas',
  })
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ type: 'varchar', length: 32 })
  eventType!: CulturalEventType;

  @Column({
    type: 'varchar',
    length: 16,
    default: DEFAULT_CULTURAL_IDEA_STATUS,
  })
  status!: CulturalIdeaStatus;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'author_id',
    foreignKeyConstraintName: 'FK_cultural_ideas_author',
  })
  author?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
