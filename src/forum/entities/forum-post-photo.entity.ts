import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A photo attached to a forum post — the multi-image half of the richer
 * composer. Modelled field for field on `EventPhoto`
 * (`src/events/entities/event-photo.entity.ts`): `storageKey` is a bare storage
 * key, never a URL, written through the same presigned upload pipeline every
 * other image slot uses (`@IsImageReference` on the write DTOs,
 * `StorageKeyOwnershipInterceptor` normalising `/files/<key>` back to the bare
 * key and refusing a key the caller does not own, `toImageUrl` resolving it on
 * the way out). It is GLOBALLY unique, so a single uploaded object is attached
 * to at most one post.
 *
 * PURELY ADDITIVE. `ForumPost.image` is untouched and stays exactly as it is:
 * it remains the first photo's home for every already-published post, and
 * nothing is backfilled out of it into this table. Moving that data is a
 * separate change that has to land atomically with a read path preferring this
 * table, which is owned elsewhere.
 *
 * No relation decorator — a bare `uuid` column with the FK
 * (`FK_forum_post_photo_post_id`, `ON DELETE CASCADE`) declared in the
 * migration, per the forum module's convention.
 */
@Entity('forum_post_photo')
@Unique('UQ_forum_post_photo_storage_key', ['storageKey'])
@Unique('UQ_forum_post_photo_post_position', ['postId', 'position'])
export class ForumPostPhoto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Owning post. No standalone index: `UQ_forum_post_photo_post_position` leads
  // with this column, so it already serves the post-scoped read (ordered by
  // `position`) and the cascade's referencing-row search.
  @Column({ type: 'uuid' })
  postId!: string;

  @Column({ type: 'text' })
  storageKey!: string;

  // Author-written alt text. Nullable on purpose: alt text is written by a
  // person, often after the upload, and a placeholder auto-filled to satisfy a
  // NOT NULL is worse for a screen reader than no alt at all — the renderer can
  // tell "undescribed" from "described as ''" only if NULL is available.
  @Column({ type: 'varchar', length: 280, nullable: true })
  alt!: string | null;

  // The author's display order within the post, 0-based and unique per post, so
  // the gallery order is stable and never tie-broken on a uuid.
  @Column({ type: 'smallint' })
  position!: number;

  // Microsecond default (no `precision: 3`), matching `EventPhoto`: photos are
  // ordered by `position`, never keyset-paginated on this column, so there is
  // no cursor resolution to match.
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
