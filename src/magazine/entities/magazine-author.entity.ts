import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A magazine byline — a curated writer with an author page (`AuthorPage.tsx`
 * in the FE, backed by `authorContent.data.tsx`'s `AUTHORS` record). Distinct
 * from a platform `User`/`Profile`: editorial bylines are seeded content, not
 * member accounts, and a byline may or may not correspond to a member.
 */
@Entity('magazine_author')
export class MagazineAuthor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_magazine_author_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true })
  bio: string | null;

  @Column({ type: 'varchar', nullable: true })
  avatarUrl: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
