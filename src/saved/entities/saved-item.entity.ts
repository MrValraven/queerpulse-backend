import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * The set of thing-kinds a member can bookmark (frontend `SavedKind`,
 * `queerpulse/src/app/providers/SavedProvider.tsx`).
 */
export enum SavedKind {
  Article = 'article',
  Film = 'film',
  Job = 'job',
  Post = 'post',
  Event = 'event',
  Group = 'group',
}

/**
 * A member's bookmark of some other resource (spec §3 Tier 2 "saved").
 * Polymorphic: `subjectType` + `subjectId` together identify the bookmarked
 * thing without an FK (targets span several unrelated tables/domains).
 *
 * The frontend's wire id is the conventional composite `${kind}:${slug}`
 * (see `SavedItemDTO.id` in `saved.api.ts`) — reconstructed on read from
 * `subjectType`/`subjectId` and parsed back into those two columns on write
 * (see `../saved-ref.util.ts`). `title`/`href`/`meta`/`description`/
 * `readTime` are the presentational snapshot the frontend sends on save (its
 * `SavedItemBody`) and expects unchanged on read — not derived server-side,
 * since a bookmark can outlive an edit/removal of the underlying resource.
 */
@Entity('saved_item')
@Unique('UQ_saved_item_subject', ['userId', 'subjectType', 'subjectId'])
export class SavedItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_saved_item_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: SavedKind,
    enumName: 'saved_item_subject_type_enum',
  })
  subjectType: SavedKind;

  @Column({ type: 'varchar' })
  subjectId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', nullable: true })
  href: string | null;

  @Column({ type: 'varchar', nullable: true })
  meta: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', nullable: true })
  readTime: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
