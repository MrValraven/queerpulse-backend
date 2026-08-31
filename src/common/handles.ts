// Shared handle rules for the ONE global username namespace (design plan PART C,
// GLOBAL CONTRACT C / UC1). Main-profile usernames and subprofile handles are
// drawn from this single namespace, so the format/reserved rules must live in
// one place used by both features. The frontend mirrors this file verbatim in
// `src/shared/handles.ts`.

// A handle is 3–30 chars, lowercase alphanumerics + dashes, not starting with a
// dash. Must stay identical to the frontend mirror and the migration's regex.
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;

// Names that can never be claimed, in two sorted groups.
//
// ROUTE COLLISIONS are names that shadow a top-level path in the app, so a
// member holding one would make `/settings` ambiguous between the screen and
// the person. This group is the original list and is unchanged.
//
// IMPERSONATION are names a reader could take as the platform itself speaking.
// Staff identity on QueerPulse is carried by a badge rather than by a name, so
// a member holding `@support` or `@moderator` can open a DM that reads as an
// official one long before anyone thinks to check for the badge, and the only
// thing standing behind that today is another member reporting it after the
// harm. Reserving a name costs a real member the chance to use it, so the test
// applied here is narrow: a word stays claimable when it merely sounds
// institutional, and is withheld only when a member receiving a message from
// it would reasonably believe the platform sent it. That is why the desk names
// an organisation actually writes from are here (`billing`, `legal`, `press`,
// `info`, `contact`, `noreply`, `notifications`), why the trust-and-safety desk
// is covered as a set (`abuse`, `safety`, `security`, `trust`), and why `team`
// is included: "the team" is how a company signs a message to its members.
// `verified` is here because it asserts the platform's own endorsement, which
// is exactly what the badge means. Both `queerpulse` and the one-hyphen
// lookalike `queer-pulse` are withheld because the brand name in the sender
// slot is the strongest impersonation signal there is; longer brand-adjacent
// constructions are left alone, since that set has no end and each extra name
// is taken from somebody.
//
// Moved here verbatim from `subprofiles/subprofile-validation.ts` (which now
// re-exports for back-compat).
export const RESERVED_HANDLES = [
  // Route collisions.
  'account',
  'admin',
  'api',
  'directory',
  'me',
  'members',
  'p',
  'profile',
  'profiles',
  'settings',
  'subprofiles',
  // Impersonation: the platform's own voice.
  'abuse',
  'admins',
  'billing',
  'contact',
  'help',
  'helpdesk',
  'info',
  'legal',
  'mod',
  'moderation',
  'moderator',
  'moderators',
  'mods',
  'no-reply',
  'noreply',
  'notification',
  'notifications',
  'official',
  'press',
  'queer-pulse',
  'queerpulse',
  'root',
  'safety',
  'security',
  'staff',
  'support',
  'system',
  'team',
  'trust',
  'verified',
];

// How long a just-released handle stays reserved to its previous owner before
// anyone else may claim it (design: handle-reclaim cooldown). Mentions are
// stored as raw `@slug` text and re-resolved at fan-out time, so an instantly
// reclaimable handle would let a stranger silently hijack old @mentions. Thirty
// days gives the namespace time to "cool" while still letting the former owner
// change their mind. Enforced entirely inside the `handles` module.
export const HANDLE_RECLAIM_COOLDOWN_DAYS = 30;
export const HANDLE_RECLAIM_COOLDOWN_MS =
  HANDLE_RECLAIM_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

// Canonical form stored in the `handles` registry (its PK): trimmed + lowercased.
// Every read/write in the namespace normalizes through this so lookups are exact.
export function normalizeHandle(s: string): string {
  return s.trim().toLowerCase();
}

// Pure format/reserved check (no DB hit). Returns the reason a name is
// unusable, or null when the name is well-formed and not reserved. Uniqueness
// ("taken") is a separate registry lookup — see HandlesService.check.
export function handleFormatError(name: string): 'invalid' | 'reserved' | null {
  const normalized = normalizeHandle(name);
  if (!HANDLE_RE.test(normalized)) {
    return 'invalid';
  }
  if (RESERVED_HANDLES.includes(normalized)) {
    return 'reserved';
  }
  return null;
}
