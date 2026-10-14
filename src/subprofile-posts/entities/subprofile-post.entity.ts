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
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A persona post (Studio v3, phase F): a short update on a persona of a
 * Studio artist kind.
 * It belongs to the persona and follows the persona's visibility.
 * `author_user_id` records which member wrote it for the data export only;
 * it never reaches the wire and goes null with an erased account.
 * `image_key` is a persona-scoped key of this persona. `created_at` is a
 * keyset cursor column, so it holds milliseconds.
 * Migration `1832000100000-AddStudioArtistTools`.
 */
@Entity('subprofile_posts')
@Index('IDX_subprofile_posts_subprofile_created_at', [
  'subprofileId',
  'createdAt',
  'id',
])
@Index('IDX_subprofile_posts_author_user_id', ['authorUserId'], {
  where: '"author_user_id" IS NOT NULL',
})
@Index('IDX_subprofile_posts_image_key', ['imageKey'], {
  where: '"image_key" IS NOT NULL',
})
@Check('CHK_subprofile_posts_body', `btrim("body") <> ''`)
export class SubprofilePost {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_subprofile_posts',
  })
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_subprofile_posts_subprofile',
  })
  subprofile?: Subprofile;

  @Column({ type: 'uuid', nullable: true })
  authorUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'author_user_id',
    foreignKeyConstraintName: 'FK_subprofile_posts_author',
  })
  author?: User | null;

  @Column({ type: 'varchar', length: 500 })
  body!: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  linkUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  imageKey!: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;
}
