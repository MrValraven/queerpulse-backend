import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// The out-at-work spectrum — a choice, never a binary toggle. Values mirror the
// frontend's `OUT_AT_WORK` list (`features/economy/workProfile.data.ts`).
// Backed by a real Postgres enum type, matching how `profiles.visibility`
// constrains its closed set (see `ProfileVisibility`).
export enum OutAtWork {
  Out = 'out',
  Verified = 'verified',
  Private = 'private',
}

// Defaults live here, not only in the DB, because a member who has never opened
// the settings page has NO ROW — the service synthesises this shape rather than
// 404ing. The column defaults below must stay in lockstep with these.
export const DEFAULT_OUT_AT_WORK = OutAtWork.Verified;
export const DEFAULT_SAFE_ONLY = true;
export const DEFAULT_PUBLIC_PROFILE_ENABLED = false;

/**
 * One row per member holding the owner-only SAFETY and VISIBILITY switches.
 *
 * Kept off `profiles` on purpose. Everything on `profiles` is loaded by every
 * profile read path (`toFullProfile` / `toMemberCard` / `toLimitedProfile`,
 * related cards, member search), so a sensitive column added there is one
 * careless spread away from being served to another member. `profiles` already
 * carries private fields (`identities`, `lookingFor`) whose only protection is
 * a hand-maintained comment — outness disclosure should not rely on that. A
 * separate table makes "this never leaves the owner's own request" structural:
 * no other query in the codebase joins it.
 *
 * `user_id` is BOTH the primary key and the FK to users (1:1) — the `Profile`
 * idiom — because this is a singleton settings row, not the sparse per-category
 * override set that `email_preference` models.
 */
@Entity('member_preferences')
export class MemberPreferences {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  // --- Work-profile safety (GET/PUT /me/work-preferences) -------------------

  @Column({
    type: 'enum',
    enum: OutAtWork,
    enumName: 'member_preferences_out_at_work_enum',
    default: DEFAULT_OUT_AT_WORK,
  })
  outAtWork: OutAtWork;

  // Closed-set option ids (see `trans-support.ts`). `text[]` with a `{}`
  // default, matching `profiles.identities` / `profiles.lookingFor`.
  @Column({ type: 'text', array: true, default: '{}' })
  transSupport: string[];

  @Column({ type: 'boolean', default: DEFAULT_SAFE_ONLY })
  safeOnly: boolean;

  // --- Public-profile visibility (GET/PUT /me/public-profile) ---------------

  /**
   * 🔴 READ THIS BEFORE BUILDING ANYTHING THAT TRUSTS THIS FLAG.
   *
   * Today this column is INERT. It records the member's stated intent and
   * nothing else: no read path anywhere in this backend consults it, and there
   * is no unauthenticated profile endpoint for it to gate. Every profile read
   * (`GET /profiles/:slug`, `GET /members`, all of `/subprofiles/*`) sits behind
   * the global `JwtAuthGuard` plus `ActiveMemberGuard`; the only `@Public()`
   * routes in the app are the auth/OAuth callbacks, `POST /auth/refresh`,
   * `POST /auth/logout`, the Mux webhook, `GET /invites/:code`,
   * `POST /join-requests`, `GET /csrf-token` and `/health*`. None of them serve
   * a member profile.
   *
   * So flipping this to `true` changes NOTHING about who can see the member's
   * data. It does not widen `profiles.visibility` (which still decides
   * full-vs-limited detail for an already-authenticated active member), and it
   * does not publish anything to the open web.
   *
   * Whoever adds the first public read path owns making this true: it must be
   * the gate on that path, and it must be combined with — never substituted
   * for — `profiles.visibility`. Until then, do not let UI copy or any other
   * service imply this flag has published anything.
   */
  @Column({ type: 'boolean', default: DEFAULT_PUBLIC_PROFILE_ENABLED })
  publicProfileEnabled: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
