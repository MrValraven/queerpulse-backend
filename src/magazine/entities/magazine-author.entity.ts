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
 * in the FE, backed by `authorContent.data.tsx`'s `AUTHORS` record).
 *
 * A byline is still its own row rather than a foreign key onto `Profile`:
 * plenty of contributors are credited by name only and hold no account. When
 * the byline DOES belong to a member, `userId` records that link (CON-11), so
 * the author page can point at the member profile, the member's own profile
 * can credit their published pieces, and the member can edit their own author
 * bio without a database console.
 */
@Entity('magazine_author')
export class MagazineAuthor {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The member account this byline belongs to, or `null` for a contributor
   * credited by name only. Populated when a commissioned piece's writer
   * (`MagazinePiece.writerId`) is a member whose display name matches the
   * piece byline, and by the staff link/unlink endpoint.
   *
   * At most ONE byline per member (partial unique index, NULLs excluded).
   * FK is `ON DELETE SET NULL`: erasing an account unlinks the byline and
   * leaves the published credit standing, matching how every other content
   * author FK survives erasure.
   */
  @Index('UQ_magazine_author_user_id', {
    unique: true,
    where: '"user_id" IS NOT NULL',
  })
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Index('UQ_magazine_author_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'varchar', nullable: true })
  avatarUrl!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
