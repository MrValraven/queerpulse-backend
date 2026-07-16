// Shared handle rules for the ONE global username namespace (design plan PART C,
// GLOBAL CONTRACT C / UC1). Main-profile usernames and subprofile handles are
// drawn from this single namespace, so the format/reserved rules must live in
// one place used by both features. The frontend mirrors this file verbatim in
// `src/shared/handles.ts`.

// A handle is 3–30 chars, lowercase alphanumerics + dashes, not starting with a
// dash. Must stay identical to the frontend mirror and the migration's regex.
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;

// Names that can never be claimed — they collide with route prefixes or would
// be confusing as a public handle. Moved here verbatim from
// `subprofiles/subprofile-validation.ts` (which now re-exports for back-compat).
export const RESERVED_HANDLES = [
  'p',
  'me',
  'admin',
  'members',
  'profile',
  'profiles',
  'settings',
  'account',
  'api',
  'subprofiles',
  'directory',
];

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
