/**
 * The identity vocabulary, server-side. Sibling of `open-to.ts`, and here for
 * the same reason: the SAME strings drive three surfaces that must agree —
 * Settings → Interests (what a member declares privately), the per-identity
 * discoverability toggles (what they publish), and the member-directory filter
 * (what other members can search on). A vocabulary split across three files
 * silently stops matching; that is precisely the bug this module exists to end.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES HERE AND NOT IN THE FRONTEND
 * ---------------------------------------------------------------------------
 * Until now the list lived ONLY in the frontend
 * (`src/features/settings/interests.data.ts`), and `profiles.identities` was a
 * free `text[]` the DTO range-checked with nothing but `@MaxLength(60)`. That is
 * tolerable for a column no query reads. It is NOT tolerable for a column the
 * directory filters on: an unvalidated value there is invisible-but-filterable
 * data (the same argument `open-to.ts` makes about unknown preset ids), and it
 * would let a caller publish an arbitrary 60-character string about themselves
 * into a search index. The server owns the closed set now.
 *
 * ---------------------------------------------------------------------------
 * TWO VOCABULARIES, ONE STORED
 * ---------------------------------------------------------------------------
 * There are genuinely two lists in play, and conflating them is what broke the
 * directory filter in the first place:
 *
 *   1. INTEREST LABELS — the fine-grained things a member declares about
 *      themselves in Settings → Interests ("Lesbian", "Non-binary",
 *      "Genderfluid", …). Stored verbatim in `profiles.identities`, and now
 *      also in `profiles.discoverable_identities`.
 *
 *   2. DIRECTORY FACETS — the seven coarse buckets the member-directory filter
 *      offers (`lesbian`, `transNonBinary`, `biPan`, …). These are a SEARCH
 *      vocabulary, not a self-description vocabulary: "Trans & non-binary" is
 *      one checkbox covering five distinct labels a member might hold.
 *
 * `discoverable_identities` stores vocabulary (1), never (2). That is a
 * deliberate choice and the whole reason the subset invariant can be enforced
 * by the DATABASE: `discoverable_identities <@ identities` is a plain
 * same-row CHECK constraint, true by construction, impossible to drift. Had we
 * stored facet ids there instead, "published ⊆ private" would have been a
 * cross-vocabulary claim no constraint could express and every future write
 * path would have had to remember the rule.
 *
 * The directory query does the translation at READ time instead:
 * `?identities=lesbian` expands to that facet's label set and runs
 * `p.discoverable_identities && :labels`. See `labelsForFacets`.
 */

/**
 * Every interest label a member may declare. Mirrors `IDENTITIES.options` in
 * the frontend's `interests.data.ts` — keep the two in lockstep; this list is
 * the authority and the DTO rejects anything outside it.
 *
 * "Prefer not to say" is included because a member may hold it privately, but
 * see `PUBLISHABLE_INTEREST_LABELS`: it is deliberately not publishable.
 */
export const INTEREST_LABELS = [
  'Gay',
  'Lesbian',
  'Bisexual',
  'Pansexual',
  'Queer',
  'Trans',
  'Non-binary',
  'Genderqueer',
  'Genderfluid',
  'Asexual',
  'Aromantic',
  'Intersex',
  'Two-spirit',
  'Questioning',
  'Ally',
  'Queer person of colour',
  'Disabled or chronically ill',
  'Prefer not to say',
] as const;

export type InterestLabel = (typeof INTEREST_LABELS)[number];

/**
 * The seven member-directory filter facets. These ids are the wire contract
 * with the frontend (`IDENTITY_OPTIONS` in `memberDirectoryFilter.data.ts`) and
 * the accepted values of `GET /members?identities=`.
 */
export const DIRECTORY_IDENTITY_FACETS = [
  'transNonBinary',
  'lesbian',
  'gay',
  'biPan',
  'aroAce',
  'qpoc',
  'disabledChronicIllness',
] as const;

export type DirectoryIdentityFacet = (typeof DIRECTORY_IDENTITY_FACETS)[number];

/**
 * Which interest labels each directory facet covers. A member is findable under
 * a facet when they have PUBLISHED at least one of its labels — publishing
 * "Genderfluid" makes you answer the "Trans & non-binary" checkbox, because
 * that is what that checkbox means to the person ticking it.
 *
 * Labels absent from every facet ("Questioning", "Ally", "Intersex",
 * "Prefer not to say") are simply not searchable. That is not an oversight:
 * a member can still publish them if the UI offers them, but no filter surfaces
 * a member by them, and none of them is a facet anyone asked to search on.
 */
export const FACET_LABELS: Record<DirectoryIdentityFacet, InterestLabel[]> = {
  transNonBinary: [
    'Trans',
    'Non-binary',
    'Genderqueer',
    'Genderfluid',
    'Two-spirit',
  ],
  lesbian: ['Lesbian'],
  gay: ['Gay'],
  biPan: ['Bisexual', 'Pansexual'],
  aroAce: ['Asexual', 'Aromantic'],
  qpoc: ['Queer person of colour'],
  disabledChronicIllness: ['Disabled or chronically ill'],
};

/**
 * "Prefer not to say" is a REFUSAL to disclose. Offering it as something you
 * can publish to a searchable directory is incoherent at best and a trap at
 * worst — a member who ticked it privately to mean "leave me out of this"
 * must never be handed a toggle that puts that very refusal into a search
 * index. It is excluded from the publishable set in the one place that
 * decides, so the settings UI, the DTO and the service all agree.
 */
export const NON_PUBLISHABLE_INTEREST_LABELS: readonly string[] = [
  'Prefer not to say',
];

const INTEREST_LABEL_SET: ReadonlySet<string> = new Set(INTEREST_LABELS);

/** The labels a member is allowed to publish, in canonical order. */
export const PUBLISHABLE_INTEREST_LABELS: InterestLabel[] =
  INTEREST_LABELS.filter(
    (label) => !NON_PUBLISHABLE_INTEREST_LABELS.includes(label),
  );

export function isInterestLabel(value: string): value is InterestLabel {
  return INTEREST_LABEL_SET.has(value);
}

/**
 * The labels this member could publish right now: the ones they actually hold
 * privately, minus the never-publishable ones. You cannot publish an identity
 * you have not claimed — that is the whole shape of the feature, and it is what
 * `pruneDiscoverable` enforces on every write.
 *
 * Order follows the member's own `identities` so the settings UI lists them the
 * way the member built the list.
 */
export function publishableFor(identities: readonly string[]): string[] {
  return identities.filter(
    (label) =>
      isInterestLabel(label) &&
      !NON_PUBLISHABLE_INTEREST_LABELS.includes(label),
  );
}

/**
 * Reduce a submitted published-set to the values that are legal for this member
 * RIGHT NOW: de-duplicated, order-stable, and intersected with what they
 * privately hold.
 *
 * This is the single chokepoint for the subset invariant. It is called from the
 * discoverability write path (where an illegal value is a client bug worth a
 * 422) AND from the profile write path (where a value becoming illegal is a
 * NORMAL consequence of the member removing a private identity, and must be
 * dropped silently rather than blocking their edit). See the callers.
 */
export function pruneDiscoverable(
  discoverable: readonly string[],
  identities: readonly string[],
): string[] {
  const allowed = new Set(publishableFor(identities));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of discoverable) {
    if (!allowed.has(label) || seen.has(label)) {
      continue;
    }
    seen.add(label);
    out.push(label);
  }
  return out;
}

const FACET_SET: ReadonlySet<string> = new Set(DIRECTORY_IDENTITY_FACETS);

export function isDirectoryIdentityFacet(
  value: string,
): value is DirectoryIdentityFacet {
  return FACET_SET.has(value);
}

/**
 * Expand directory facet ids to the stored interest labels they cover, for the
 * `p.discoverable_identities && :labels` overlap test. Unknown facet ids
 * contribute nothing — the DTO has already rejected them, so reaching this with
 * one would be a programming error, not a user input.
 *
 * Returns a de-duplicated list; facets do not currently overlap, but relying on
 * that would make adding one a landmine.
 */
export function labelsForFacets(facets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const facet of facets) {
    if (!isDirectoryIdentityFacet(facet)) {
      continue;
    }
    for (const label of FACET_LABELS[facet]) {
      out.add(label);
    }
  }
  return [...out];
}
