import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Mirrors the frontend `Slide` union (`queerpulse/.../data/decks.tsx`). Stored
 * verbatim as jsonb on `MagazineDeck.slides`; validated in the service (see
 * `deck-slides.validation.ts`), never by the ORM or TypeORM decorators.
 */
export type DeckSlide =
  | {
      layout: 'text';
      eyebrow?: string;
      heading?: string;
      body?: string;
      pull?: string;
      align?: 'left' | 'center';
    }
  | {
      layout: 'image';
      src: string;
      alt: string;
      caption?: string;
      overlay?: string;
      tint: string;
    }
  | {
      layout: 'stat';
      value: string;
      unit?: string;
      label: string;
      source?: string;
      tint: string;
    }
  | {
      layout: 'interactive';
      kind: 'before-after';
      before: { src: string; alt: string; label: string };
      after: { src: string; alt: string; label: string };
    }
  | {
      layout: 'interactive';
      kind: 'reveal';
      prompt: string;
      hidden: string;
      tint?: string;
    };

/**
 * An interactive slide-deck magazine piece (`data/decks.tsx` /
 * `SlideDeck` on the frontend). Draft/published via the repo's nullable-
 * `publishedAt` idiom (`MagazineArticle` precedent), not a status enum.
 */
@Entity('magazine_deck')
export class MagazineDeck {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_magazine_deck_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar', default: '' })
  kicker!: string;

  @Column({ type: 'varchar', default: '' })
  section!: string;

  @Column({ type: 'varchar', default: '' })
  byline!: string;

  @Column({ type: 'varchar', nullable: true })
  role!: string | null;

  @Column({ type: 'text', default: '' })
  authorBio!: string;

  @Column({ type: 'varchar', default: '' })
  cover!: string;

  @Column({ type: 'varchar', default: '' })
  coverDesc!: string;

  @Column({ type: 'varchar', default: '' })
  readTime!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  tags!: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  related!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  slides!: DeckSlide[];

  @Index('IDX_magazine_deck_published_at')
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
