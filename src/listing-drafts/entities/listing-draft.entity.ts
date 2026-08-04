import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A member's work-in-progress "list a business" wizard draft (wizard overhaul
 * item #11). Unlike the generic `draft` table (`src/drafts`, which mirrors a
 * closed content view-model — job/pitch/grant/post — with a caller-supplied
 * string id and no resume token), a listing draft is:
 *
 *  - **server-keyed by a generated `id` (uuid)** so the frontend can hold
 *    several in-progress listings at once and autosave each one back by id,
 *  - **opaque `payload` (jsonb)** — the whole `ListingDraft` wizard state,
 *    stored verbatim and never re-derived server-side (its shape is owned by
 *    the frontend wizard, not by this table), and
 *  - carries an **unguessable `resumeToken`** that backs the cross-device
 *    resume link (`…/local/list-business?draft=<resumeToken>`), which the
 *    generic drafts table has no notion of.
 *
 * Those three differences are why this is a dedicated table rather than a new
 * `kind` on `draft` — see the build report.
 *
 * `userId` has an FK to `users` with `ON DELETE CASCADE`, so a member's drafts
 * are erased with their account.
 */
@Entity('listing_drafts')
// Hot path: `GET /listing-drafts` — filter by owner, newest-edited first.
@Index('IDX_listing_drafts_user_id_updated_at', ['userId', 'updatedAt'])
export class ListingDraft {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  // The frontend's serialised `ListingDraft` wizard state. Stored opaquely:
  // this table never validates or reads its inner shape beyond deriving a
  // display name (`payload.name`) for the list view.
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  // Unguessable handle for the cross-device resume link. `unique` so a token
  // resolves to exactly one draft; minted with `randomBytes(32)` on create.
  @Column({ type: 'varchar', unique: true })
  resumeToken!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
