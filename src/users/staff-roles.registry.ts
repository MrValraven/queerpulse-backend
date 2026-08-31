/**
 * Code-defined catalog of additive "staff roles", functional grants that sit
 * on TOP of the account tier (User.role), not tiers above it. A member may hold
 * any set of these independent of being member/moderator/admin.
 *
 * Adding a future role: add one entry here + wire its @StaffRoles() guard on the
 * endpoints it should open. The `role` column is a varchar validated against
 * this map, so NO migration is needed for a new role. Admin is always a superset
 * (see StaffRolesGuard / RolesOrStaffGuard), so admins are never granted these
 * explicitly.
 *
 * Two guards read these grants, and which one a controller uses says how the
 * grant behaves there:
 *   - `StaffRolesGuard` NARROWS: the grant is the only way in besides being an
 *     admin (the magazine desk and the writer workspace work this way).
 *   - `RolesOrStaffGuard` WIDENS: the endpoint keeps its `@Roles(...)` tier and
 *     the grant satisfies it on its own. Every domain grant below is of this
 *     kind, which is what makes delegating one queue possible without handing
 *     over the whole platform.
 *
 * WHAT NO GRANT EVER OPENS. These stay Admin-only (or Moderator/Admin) on
 * purpose, and no entry below may be extended onto them: member restriction,
 * suspension and bans; the lockdown and kill switches (`platform-settings`);
 * governance and its finances; the trust network; DSAR; system accounts;
 * invites and join requests; identity verification; and any surface that serves
 * private report content, including the safe-space flag queue (the only place a
 * flagger's identity and free text are served) and `/admin/reports` (which
 * carries governance finance history).
 *
 * HOW THAT PROMISE IS KEPT ON A SHARED ENDPOINT. Some endpoints a grant opens
 * carry a little of the reserved material inside an otherwise ordinary
 * response. Closing them would take the whole surface back; passing the
 * response through unchanged would break the promise above. Those handlers
 * instead ask `isPlatformStaffTier(user.role)` — the caller's ACCOUNT tier,
 * which a grant never changes — and serve the grant holder a narrower body:
 * the community report queue without the reporter's narrative, the governance
 * log through the community's own allowlist instead of the raw jsonb, the
 * badge audit without its flag rows. The gate stays where the guard put it;
 * only the amount of the answer moves. Whenever a `grants:` line below says
 * "NOT x" about a route the grant can still call, that is the mechanism.
 */
export type StaffRoleId =
  | 'magazine_editor'
  | 'magazine_writer'
  | 'housing_moderator'
  | 'directory_moderator'
  | 'resource_curator'
  | 'editorial'
  | 'communities'
  | 'partnerships';

export interface StaffRoleDef {
  id: StaffRoleId;
  /** Human-readable note of what this unlocks. Not enforced, guards key off id. */
  grants: string[];
  /**
   * Whether holding this grant earns a public staff badge on the member's name
   * across the platform (`GET /platform/staff`, rendered by the frontend's
   * `StaffBadge`). Presentation only: this flag opens nothing, closes nothing
   * and is read by no guard. The one question it answers is whether the people
   * whose listings, pieces and communities this grant reaches get to see, from
   * the name alone, that the person acting on them works for the platform.
   *
   * The rule for setting it: badge a grant when its holder exercises power over
   * OTHER members' content or membership. Someone who can decline a housing
   * listing or spike a magazine piece is acting as the platform, and the member
   * on the other side of that decision deserves to know it without having to
   * ask. Two roles are deliberately left unbadged, and a new role should have to
   * clear the same bar rather than inherit a default:
   *
   *   - `magazine_writer` holds no power over anyone. Its own `grants` list says
   *     every read is scoped server-side to the caller's own work, so it never
   *     touches another member's piece, fee, pitch or thread. Badging it would
   *     tell readers that a contributor speaks for the platform when they only
   *     write for it.
   *   - `partnerships` decides about organisations and about changemaker
   *     nominations, so its decisions land on applying organisations and on
   *     third-party nominees rather than on a member's own membership or their
   *     own content. Nothing it decides changes what a member may post or
   *     whether they stay.
   *
   * Account tiers are a separate axis entirely: moderators and admins are on the
   * roster because of `User.role`, and never need a grant to be badged.
   */
  hasPublicStaffBadge: boolean;
}

export const STAFF_ROLES: Record<StaffRoleId, StaffRoleDef> = {
  magazine_editor: {
    id: 'magazine_editor',
    hasPublicStaffBadge: true,
    grants: [
      'The magazine editorial desk (/magazine/editor): every piece with its brief, draft and version history, the issue production record, the pitch inbox and the published archive',
      'The desk money tab: each piece’s agreed fee, expenses, invoice reference and payment status, plus the per-issue cost roll-up',
      'A piece’s care record: the consent and sensitivity-read tracking the publish gate is computed from, including whether a person named in a piece is publicly out',
      'Edit any byline and the member account linked to it (magazine/admin/authors)',
    ],
  },
  magazine_writer: {
    id: 'magazine_writer',
    hasPublicStaffBadge: false,
    grants: [
      'Draft and submit magazine pieces from the writer workspace (magazine/writer): your OWN assignments, pitches, payments, byline and editor thread',
      'NOT anything about another contributor: every read is scoped server-side to the caller’s own writerId/submitterId, so the workspace never lists another writer’s piece, fee, pitch or thread',
      'NOT the editor desk: no care record, no pitch inbox, no audit trail, no editor directory, and no rate but your own',
    ],
  },
  housing_moderator: {
    id: 'housing_moderator',
    hasPublicStaffBadge: true,
    grants: [
      'Moderate Housing listings and groups (admin/housing-listings, admin/housing-groups)',
    ],
  },
  directory_moderator: {
    id: 'directory_moderator',
    hasPublicStaffBadge: true,
    grants: [
      'Review the local directory queue: approve, reject and edit listings (admin/listings)',
      'Work the safe-space nomination queue (admin/safe-space-nominations)',
      'Suspend, restore and re-review safe-space badges (admin/safe-spaces)',
      'Read a badge’s own history: its nomination and its suspensions and restorations (admin/safe-spaces/:ref/audit)',
      'NOT the safe-space flag queue (admin/safe-space-flags), and NOT the flag rows of that badge audit: the identity and free text of whoever raised a flag stay Moderator/Admin',
      'NOT the identity of whoever nominated a place: the nomination queue arrives with the place, the nominator’s own written reason, the 48-hour clock and the independent-visit tally, and without `nominatorId`',
      'NOT the listing owner as a person: the listings queue and every listing echo arrive without the owner’s contact email and without their outing and guide consent decisions (admin/listings)',
    ],
  },
  resource_curator: {
    id: 'resource_curator',
    hasPublicStaffBadge: true,
    grants: [
      'Write and revise the resource guides, and stamp an editorial review (admin/resources)',
      'Maintain the service and crisis-line listings (admin/resource-listings)',
      'Triage member resource suggestions (admin/resource-suggestions)',
      'Maintain the glossary, minus deletion (admin/glossary)',
      'Read the guide feedback ratings as an aggregate: the helpful and not-helpful split per guide, never who voted (admin/resources/guide-ratings)',
      'NOT publish, unpublish or delete a guide: putting an unreviewed crisis guide on the site, or taking one off, stays Admin-only',
    ],
  },
  editorial: {
    id: 'editorial',
    hasPublicStaffBadge: true,
    grants: [
      'Triage reader story submissions (admin/magazine-submissions), including the text and cover the member submitted, which is what the decision is made on',
      'Review writer applications (admin/magazine-writer-applications), and grant the magazine_writer role by approving one (recorded in the moderation audit log)',
      'NOT your own writer application: approving one grants a staff role, so someone else has to review yours',
      'Read commission-board interest (admin/commission-interests), including the message the member wrote, which is the substance of the interest',
      'Maintain the film-club titles end to end: create, edit, upload and reconcile against Mux (admin/titles), and on the read side (cinema/titles) list drafts and failed ingests, open an unpublished title, read its Mux status and error, and play it back to check it works',
      'NOT delete a cinema title: that destroys the Mux assets irreversibly and stays Moderator/Admin',
      'Maintain the press kit (admin/press-kit) and the landing-page feature slots (admin/landing)',
      'NOT a member directory: the landing picker only lists members who set an Open profile AND explicitly consented to being featured',
      'Separate from magazine_editor, which is the piece-by-piece desk itself: no piece, brief, care record, writer fee or issue cost is readable here',
    ],
  },
  communities: {
    id: 'communities',
    hasPublicStaffBadge: true,
    grants: [
      'Read every community with its health metrics and governance log, and set its safety-policy options (admin/communities)',
      'NOT the free text a reporter wrote: the scoped report queue on a community arrives with its severity, reason and counts and without the narrative',
      "NOT the raw governance-log metadata: a ban entry is read through the same narrowed shape the community's own moderators get (the note, never the raw actor ids), so a grant never sees more about a sanction than the people who issued it",
      'Decide community tag requests (admin/community-tag-requests): the community it came from, the label asked for and the requester’s note',
      'NOT the name of the member who asked for a tag: deciding a word is a decision about the word, and the resolve notifies them without a reviewer ever needing to know who they are',
      "Appoint and stand down a community's own moderators (admin/communities/:slug/moderators), never yourself",
      'Curate the topic directory (admin/topics)',
      'Decide reading-group proposals (admin/reading-group-proposals)',
      'NOT freeze, archive, reassign ownership or remove a roster member: moderation of last resort stays Admin-only',
      'NOT the official-byline switch (admin/forum), which speaks in the name of the platform itself',
    ],
  },
  partnerships: {
    id: 'partnerships',
    hasPublicStaffBadge: false,
    grants: [
      'Review partner applications and maintain the partner directory (admin/partners), including the applying organisation’s own contact block: the phone, email, website and address it submitted, which go public on its directory page the moment it is approved',
      'Maintain the organisation tiers (admin/org-tiers). The only money here is `priceDisplay`, the figure the public For Organisations page prints; there is no negotiated fee and no internal number in this domain',
      'Maintain the changemaker roster and its nominations (admin/changemakers, admin/changemaker-nominations): the nominee, the reason written for them, and the triage history',
      'NOT who nominated whom: a nomination is a private submission about a third party who never opted in and may not know they were named, so the pairing of the two names stays Moderator/Admin while the pitch itself is delegated',
    ],
  },
};

export const STAFF_ROLE_IDS = Object.keys(STAFF_ROLES) as StaffRoleId[];

/**
 * The grants whose holders earn a public staff badge, in registry order so the
 * roster and the badge row read the same way everywhere. Derived from the flag
 * rather than hand-listed: a hand-kept second list beside the catalog it mirrors
 * is drift nobody can see until a badge is missing.
 */
export const BADGED_STAFF_ROLE_IDS: StaffRoleId[] = STAFF_ROLE_IDS.filter(
  (staffRoleId) => STAFF_ROLES[staffRoleId].hasPublicStaffBadge,
);

/** Whether a raw `user_staff_roles.role` value is a grant that earns a badge. */
export function isBadgedStaffRoleId(value: string): value is StaffRoleId {
  return isStaffRoleId(value) && STAFF_ROLES[value].hasPublicStaffBadge;
}

export function isStaffRoleId(value: string): value is StaffRoleId {
  return Object.prototype.hasOwnProperty.call(STAFF_ROLES, value);
}
