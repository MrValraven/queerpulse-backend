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
 * Login alerts default ON — the opposite of `publicProfileEnabled`, and for the
 * same reason it is off: the safe default is the one a member would pick if
 * they had read the setting. Nobody opts in to being told their account was
 * signed in to from a device they do not recognise.
 */
export const DEFAULT_LOGIN_ALERTS_ENABLED = true;

/**
 * Lock-screen previews are HIDDEN by default (ID-13).
 *
 * The safe default is the one a member would pick if they had read the setting,
 * and the cost of being wrong is not symmetric: a hidden preview costs a member
 * one extra tap, while a shown preview can out them to whoever is standing next
 * to their phone. A push that says "QueerPulse, you have a new notification"
 * still gets them to the app; a push that says "Mariana: are you still coming to
 * the trans peer group?" cannot be taken back.
 *
 * A member who has never opened settings therefore has no row and gets hidden
 * previews, and `PushPreviewPrivacyService` treats an absent row the same way.
 */
export const DEFAULT_HIDE_PUSH_PREVIEWS = true;

/**
 * The three content-sensitivity filters default to SHOWING everything
 * (PRD-10), so `hide*` is false until the member says otherwise.
 *
 * The safe default is the one a member would pick if they had read the
 * setting, and here that is "show me the platform". Every other default in
 * this file protects the member from something leaving their control: a
 * preview reaching a lock screen, a profile reaching the open web. A content
 * filter is the opposite shape. Nothing escapes when it is off, and shipping
 * it on would silently subtract whole communities from the feed of every
 * member who has never opened Settings, including the trans and coming-out
 * rooms that are the reason many of them are here. A filter nobody asked for
 * that removes content nobody can see they are missing is worse than no
 * filter at all.
 *
 * So the harm is asymmetric in the other direction from `hidePushPreviews`:
 * a wrongly shown feed card costs one scroll, a wrongly hidden community
 * costs a member the room they joined for.
 */
export const DEFAULT_HIDE_DATING_CONTENT = false;
export const DEFAULT_HIDE_MENTAL_HEALTH_CONTENT = false;
export const DEFAULT_HIDE_SEXUALITY_IDENTITY_CONTENT = false;

/**
 * Being recommended to strangers is ON by default (PRD-16): `hideFromSuggestions`
 * is false until the member opts out.
 *
 * This one follows the shipped behaviour rather than the cautious reading, and
 * that is a deliberate exception to the rule the constants above state. The
 * suggestion strip only ever surfaces people a viewer could already find in
 * the member directory, under exactly the directory's own visibility gates
 * (see `MemberSuggestionsService`'s docstring). Defaulting to hidden would
 * therefore protect nothing that `profiles.visibility` does not already
 * protect, while emptying the strip for a platform whose whole premise is that
 * members meet each other.
 *
 * What was missing was the LEVER, not the default: until this column there was
 * no way to stop being recommended at all, and the 24-hour `hidden_until`
 * blackout was the only thing resembling one.
 */
export const DEFAULT_HIDE_FROM_SUGGESTIONS = false;

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
 * idiom, because this is a singleton settings row rather than a sparse
 * per-category override set of the kind `notification_preferences` models.
 */
@Entity('member_preferences')
export class MemberPreferences {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  // --- Work-profile safety (GET/PUT /me/work-preferences) -------------------

  @Column({
    type: 'enum',
    enum: OutAtWork,
    enumName: 'member_preferences_out_at_work_enum',
    default: DEFAULT_OUT_AT_WORK,
  })
  outAtWork!: OutAtWork;

  // Closed-set option ids (see `trans-support.ts`). `text[]` with a `{}`
  // default, matching `profiles.identities` / `profiles.lookingFor`.
  @Column({ type: 'text', array: true, default: '{}' })
  transSupport!: string[];

  @Column({ type: 'boolean', default: DEFAULT_SAFE_ONLY })
  safeOnly!: boolean;

  // Skills the member offers in the skills exchange. Closed-set option ids (see
  // `work-skills.ts`). `text[]` with a `{}` default, matching `transSupport`.
  @Column({ type: 'text', array: true, default: '{}' })
  skills!: string[];

  // Focus areas the member wants mentor support with. Closed-set option ids
  // (see `focus-areas.ts`). `text[]` with a `{}` default.
  @Column({ type: 'text', array: true, default: '{}' })
  focusAreas!: string[];

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
  publicProfileEnabled!: boolean;

  // --- Account security (GET/PUT /me/login-alerts) --------------------------

  /**
   * Whether to tell this member when their account is signed in to from a
   * device they have not used before.
   *
   * Read at the EMIT site (`AuthService.issueTokens`), not in
   * `NotificationsService`, so switching it off silences the bell and the push
   * in one place rather than leaving a row written that nothing renders.
   *
   * It lives here rather than as a `NotificationPreferenceCategory` because
   * those categories are content volume controls — "gathering invites",
   * "replies to my threads" — and a sign-in alert is not content. Putting it in
   * that list would also have put it on the Notifications pane, when the member
   * looking for it is on the Account pane, next to their active sessions.
   *
   * Defaults ON (see `DEFAULT_LOGIN_ALERTS_ENABLED`), which is why a member
   * with no row at all still gets alerted.
   */
  @Column({ type: 'boolean', default: DEFAULT_LOGIN_ALERTS_ENABLED })
  loginAlertsEnabled!: boolean;

  // --- Lock-screen privacy (GET/PUT /me/push-previews) ----------------------

  /**
   * Whether a push notification for this member may name who it is from and
   * what it said, or must arrive as "QueerPulse, you have a new notification".
   *
   * THIS COLUMN IS THE AUTHORITY, and it has to be, because of one platform
   * detail: iOS never runs the service worker's push handler. Every other
   * engine lets `sw.ts` rewrite a payload before `showNotification`, so the
   * IndexedDB mirror this used to live in was enough. On an iPhone the payload's
   * plain `title`/`body` are rendered verbatim by the OS, so the ONLY place the
   * sender's name can be removed is the composer, here, before the push is
   * ever encrypted. See `PushPreviewPrivacyService`.
   *
   * Being server-side is also what carries the choice across devices: a member
   * who hides previews on their phone does not have to remember to do it again
   * on a tablet, and the app mirrors this value back into IndexedDB on boot so
   * the service worker keeps degrading payloads as a second line of defence.
   *
   * Read on the SEND path, never at the emit site: unlike `loginAlertsEnabled`
   * this does not suppress anything, it changes what a notification says. The
   * bell row is written in full either way, and the app shows everything once
   * it is open and unlocked.
   *
   * Defaults to TRUE (see `DEFAULT_HIDE_PUSH_PREVIEWS`).
   */
  @Column({ type: 'boolean', default: DEFAULT_HIDE_PUSH_PREVIEWS })
  hidePushPreviews!: boolean;

  // --- Content sensitivity (GET/PUT /me/content-sensitivity) ----------------

  /**
   * The three "do not show me this" filters from the Interests pane (PRD-10).
   *
   * They shipped as inert placeholder switches with no column, no filter and
   * no surface: the pane rendered them `defaultChecked` and badged
   * coming-soon, and flipping one changed nothing anywhere. For this audience
   * "do not show me mental-health content" is a real need rather than a
   * nice-to-have, so they are now stored here and READ ON THE FEED PATH
   * (`FeedService.fetchCandidates`, via `src/feed/content-sensitivity.ts`).
   *
   * SCOPE, STATED PLAINLY because a filter that quietly covers less than the
   * member thinks is its own kind of defect. Each flag hides feed items whose
   * COMMUNITY carries a tag classified into that sensitivity, plus forum
   * threads whose own tags match. It does not touch community browse, search,
   * the magazine, resources or a member's own rooms: the pane's helper copy
   * promises exactly that ("Turning these off never affects your community
   * access, only your feed"), and the classification behind it is derived from
   * `COMMUNITY_TAGS` rather than hand-copied beside it.
   *
   * Named for what they DO, following `hidePushPreviews`: a `showDating`
   * spelling reads as the opposite to whoever wires the toggle next, and a
   * privacy control a plausible misreading can invert eventually gets
   * inverted.
   */
  @Column({ type: 'boolean', default: DEFAULT_HIDE_DATING_CONTENT })
  hideDatingContent!: boolean;

  @Column({ type: 'boolean', default: DEFAULT_HIDE_MENTAL_HEALTH_CONTENT })
  hideMentalHealthContent!: boolean;

  @Column({ type: 'boolean', default: DEFAULT_HIDE_SEXUALITY_IDENTITY_CONTENT })
  hideSexualityIdentityContent!: boolean;

  // --- Suggestion visibility (GET/PUT /me/suggestion-visibility) ------------

  /**
   * Whether this member may be RECOMMENDED to other people (PRD-16).
   *
   * `true` removes them from every other member's suggestion strip. It is
   * enforced in the candidate QUERY (`MemberSuggestionsService.visibleCandidates`),
   * beside the block, hidden-from and dismissal gates, so an opted-out member
   * cannot be scored and then leaked by a mapping bug further down.
   *
   * IT IS ONE-DIRECTIONAL, on purpose. Opting out stops the member being
   * suggested; it never stops them SEEING suggestions. The switch lives on the
   * Visibility pane, which is about what others see of you, and the member is
   * not asking to leave people discovery, they are asking to stop being
   * merchandise in it. A tit-for-tat rule ("no suggestions for you either")
   * would price a privacy choice, and the receiving side already has its own
   * controls: per-person dismissal and the 24-hour `profiles.hidden_until`
   * blackout.
   *
   * It is also NARROWER than `hidden_until`. This column governs the
   * suggestion strip alone: the member stays listed in the member directory,
   * stays visible on their own profile, and stays findable by search, all
   * under whatever `profiles.visibility` already allows. A member who wants to
   * disappear from the directory too has `visibility` for that.
   */
  @Column({ type: 'boolean', default: DEFAULT_HIDE_FROM_SUGGESTIONS })
  hideFromSuggestions!: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
