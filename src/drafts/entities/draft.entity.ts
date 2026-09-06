import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

// Mirrors `Draft["kindVariant"]` in the frontend's
// queerpulse/src/features/members/drafts.data.tsx.
export enum DraftKindVariant {
  Job = 'job',
  Pitch = 'pitch',
  Grant = 'grant',
  Post = 'post',
}

// Mirrors the frontend's `DraftCategory` union (tab bucket).
export enum DraftCategory {
  Posts = 'posts',
  Articles = 'articles',
  Applications = 'applications',
  Grants = 'grants',
}

// Mirrors the frontend's `DraftStatus` union (status chip / at-risk pinning).
export enum DraftStatus {
  Draft = 'draft',
  Ready = 'ready',
  Stale = 'stale',
  AtRisk = 'atrisk',
}

/**
 * The serialisable subset of the frontend's client-side `Draft` view-model
 * that syncs to the server (`DraftDTO` in `drafts.api.ts`). `meta`/`actions`
 * are ReactNode and stay client-only — `draftToDto`/`dtoToDraft` drop them on
 * the way out and rebuild them as empty arrays on the way back in.
 */
export interface DraftPayload {
  kindVariant: DraftKindVariant;
  title: string;
  desc: string;
  progress: number;
  ready?: boolean;
  category?: DraftCategory;
  status?: DraftStatus;
  href?: string;
  editedMinutes?: number;
  deadlineDays?: number | null;
  sortTitle?: string;
  searchText?: string;
}

/**
 * One value a composer may park in {@link DraftMeta}.
 *
 * Deliberately flat and scalar (plus a list of strings for things like tags):
 * a nested, free-form JSON tree accepted from a client is a depth bomb and an
 * unbounded storage sink, and nothing any composer needs to remember about
 * itself is more than a field value.
 */
export type DraftMetaValue = string | number | boolean | null | string[];

/**
 * A draft's composer state: the fields a surface needs to reopen exactly where
 * the member left it, which the drafts-list payload has no room for.
 *
 * Kind-AGNOSTIC on purpose. `/me/drafts` already backs job applications,
 * magazine pitches, grant applications and forum posts, so the forum's
 * category / community / tags / photo reference must not become four columns
 * on a table every other kind of draft shares. Each composer owns the keys it
 * writes and ignores keys it does not recognise, exactly like a query string.
 *
 * The forum's new-thread composer writes `title`, `category`, `communitySlug`,
 * `tags`, `imageKey` and `imagePreviewUrl` here (see the frontend's
 * `forumDraftSnapshot.ts`). PRD-165: those used to live in the browser alone,
 * so a post started on a phone came back on a laptop as a body with the
 * category, community, tags and photo silently gone.
 *
 * Only a REFERENCE to an uploaded photo is ever stored here; the bytes stay in
 * the bucket. A base64 image would be a member-controlled multi-megabyte write
 * on every keystroke's autosave.
 */
export type DraftMeta = Record<string, DraftMetaValue>;

/**
 * A user's work-in-progress content draft (job application, magazine pitch,
 * grant application, community post/reply, ...). `kind` is the free-form
 * display label the frontend renders verbatim (e.g. "JOB", "PITCH", "€",
 * "POST", "REPLY") — not to be confused with `payload.kindVariant`, the
 * closed enum that drives icon/behaviour.
 *
 * `id` is caller-supplied, not server-generated: the frontend mints its own
 * opaque id client-side (e.g. `invite-${Date.now()}`, see
 * `DraftsProvider.addDraft`) and uses it as the durable key across an
 * optimistic create → later delete without waiting on the server's response.
 * The primary key is therefore the composite `(user_id, id)` — scoping
 * uniqueness to the owning user so two different users can never collide on
 * the same client-chosen id.
 */
@Entity('draft')
@Index('IDX_draft_user_id_updated_at', ['userId', 'updatedAt'])
export class Draft {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Index('IDX_draft_user_id')
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  kind!: string;

  @Column({ type: 'jsonb' })
  payload!: DraftPayload;

  /**
   * Composer state (see {@link DraftMeta}), or `null` for a draft whose surface
   * keeps none.
   *
   * A column of its own rather than another key inside `payload`: `payload` is
   * the drafts-LIST view-model (title, description, progress, status chip) and
   * merges field by field on a patch, while `meta` is private to the composer
   * and must replace WHOLESALE. A tag the member removed has to disappear, and
   * a per-field merge would keep resurrecting it.
   *
   * Bounded before it ever reaches here: `@IsDraftMeta` caps the serialized
   * size, the key count, and every key and value, so an autosaving client
   * cannot turn a draft row into a storage sink.
   */
  @Column({ type: 'jsonb', nullable: true })
  meta!: DraftMeta | null;

  /**
   * Optimistic-concurrency counter. A draft is an autosaving surface that a
   * member can legitimately have open in two tabs (or on a phone and a laptop
   * at once), and `update` merges a partial patch onto the STORED payload — so
   * two interleaved saves used to resolve last-write-wins, with the loser's
   * edits gone and nothing to say so. `DraftsService.update` now writes under
   * an `UPDATE ... WHERE version = :expected` precondition when the client
   * declares the version it read.
   */
  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
