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
export class Draft {
  @PrimaryColumn({ type: 'varchar' })
  id: string;

  @Index('IDX_draft_user_id')
  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  kind: string;

  @Column({ type: 'jsonb' })
  payload: DraftPayload;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
