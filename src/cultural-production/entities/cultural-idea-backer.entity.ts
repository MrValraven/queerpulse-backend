import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { CulturalIdea } from './cultural-idea.entity';

/**
 * Cultural Production: one row per idea and staff member who backs it. A
 * staff-only table. A deleted idea or account takes its rows through the
 * cascade. The primary key `(idea_id, user_id)` serves every per-idea read and
 * `IDX_cultural_idea_backers_user_id` serves the cascade from `users`.
 * Migration `1840600000000-AddCulturalProduction`.
 */
@Entity('cultural_idea_backers')
@Index('IDX_cultural_idea_backers_user_id', ['userId'])
export class CulturalIdeaBacker {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_cultural_idea_backers',
  })
  ideaId!: string;

  @ManyToOne(() => CulturalIdea, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'idea_id',
    foreignKeyConstraintName: 'FK_cultural_idea_backers_idea',
  })
  idea?: CulturalIdea;

  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_cultural_idea_backers',
  })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_cultural_idea_backers_user',
  })
  user?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
