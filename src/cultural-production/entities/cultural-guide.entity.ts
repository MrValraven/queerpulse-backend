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
import type {
  CulturalEventType,
  CulturalGuideLocale,
  CulturalGuideSectionRecord,
} from '../cultural-production.constants';

/**
 * Cultural Production: one event guide in one language, its sections and
 * their checklist steps stored together in `sections`. A staff-only table.
 * Saving replaces the whole guide and raises `revision`, so two producers
 * editing at once never overwrite each other. A deleted account leaves the
 * guide with no author or last editor. `IDX_cultural_guides_event_type_locale`
 * serves the guides list order. Migration
 * `1840600000000-AddCulturalProduction`.
 */
@Entity('cultural_guides')
@Index('IDX_cultural_guides_event_type_locale', ['eventType', 'locale'])
@Index('IDX_cultural_guides_author_id', ['authorId'], {
  where: '"author_id" IS NOT NULL',
})
@Index('IDX_cultural_guides_updated_by_id', ['updatedById'], {
  where: '"updated_by_id" IS NOT NULL',
})
@Check('CHK_cultural_guides_title', `char_length(btrim("title")) >= 1`)
@Check(
  'CHK_cultural_guides_event_type',
  `"event_type" IN ('board_game_night', 'quiz_night', 'music_night', 'film_night', 'workshop', 'talk', 'party', 'other')`,
)
@Check('CHK_cultural_guides_locale', `"locale" IN ('en', 'pt')`)
@Check(
  'CHK_cultural_guides_sections',
  `CASE WHEN jsonb_typeof("sections") = 'array' THEN jsonb_array_length("sections") <= 30 ELSE false END`,
)
@Check('CHK_cultural_guides_revision', `"revision" >= 1`)
export class CulturalGuide {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_cultural_guides',
  })
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'varchar', length: 32 })
  eventType!: CulturalEventType;

  @Column({ type: 'varchar', length: 2 })
  locale!: CulturalGuideLocale;

  @Column({ type: 'varchar', length: 500, default: '' })
  summary!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  sections!: CulturalGuideSectionRecord[];

  @Column({ type: 'integer', default: 1 })
  revision!: number;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'author_id',
    foreignKeyConstraintName: 'FK_cultural_guides_author',
  })
  author?: User | null;

  @Column({ type: 'uuid', nullable: true })
  updatedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'updated_by_id',
    foreignKeyConstraintName: 'FK_cultural_guides_updated_by',
  })
  updatedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
