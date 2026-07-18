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
   * 🔴 THIS FLAG PUBLISHES TO THE OPEN WEB. It is no longer inert.
   *
   * It gates `GET /public/profiles/:slug` (`src/public-profiles`) — the one
   * unauthenticated route in this API that serves member data. When it is
   * `true`, anyone with no account, no invite and no audit trail can read the
   * member's display name, pronouns, tagline, avatar, bio, links and public
   * work. Every other profile read (`GET /profiles/:slug`, `GET /members`, all
   * of `/subprofiles/*`) still sits behind `JwtAuthGuard` + `ActiveMemberGuard`
   * and ignores this column.
   *
   * It is a NECESSARY, NOT SUFFICIENT condition, and it never widens anything.
   * The public route requires all three of:
   *   1. this flag `true` (absent row ⇒ `false` ⇒ not published);
   *   2. `users.status = 'active'`, so deactivation and the erasure grace
   *      period hide the member from the open web immediately;
   *   3. `profiles.visibility = 'open'` — the flag INTERSECTS visibility rather
   *      than overriding it, so an anonymous viewer can never see more than the
   *      least privileged signed-in member. `network`/`private` 404 publicly.
   *
   * If you add a field to that endpoint's response, you are making a
   * publish-to-the-world decision — see the allowlist in
   * `src/public-profiles/public-profile-response.ts`, which names every field
   * on purpose so a new `profiles` column cannot auto-appear.
   */
  @Column({ type: 'boolean', default: DEFAULT_PUBLIC_PROFILE_ENABLED })
  publicProfileEnabled: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
