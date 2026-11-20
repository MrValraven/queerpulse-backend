import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { CulturalIdea } from './cultural-idea.entity';

/**
 * Cultural Production: one staff comment on an idea. A staff-only table. A
 * deleted idea takes its comments with it; a deleted account leaves its
 * comments with no author. `IDX_cultural_idea_comments_idea_created_at`
 * serves the comment thread in posting order. Migration
 * `1840600000000-AddCulturalProduction`.
 */
@Entity('cultural_idea_comments')
@Index('IDX_cultural_idea_comments_idea_created_at', [
  'ideaId',
  'createdAt',
  'id',
])
@Index('IDX_cultural_idea_comments_author_id', ['authorId'], {
  where: '"author_id" IS NOT NULL',
})
@Check(
  'CHK_cultural_idea_comments_body',
  `char_length(btrim("body")) >= 1 AND char_length("body") <= 2000`,
)
export class CulturalIdeaComment {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_cultural_idea_comments',
  })
  id!: string;

  @Column({ type: 'uuid' })
  ideaId!: string;

  @ManyToOne(() => CulturalIdea, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'idea_id',
    foreignKeyConstraintName: 'FK_cultural_idea_comments_idea',
  })
  idea?: CulturalIdea;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'author_id',
    foreignKeyConstraintName: 'FK_cultural_idea_comments_author',
  })
  author?: User | null;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
