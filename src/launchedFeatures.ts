/**
 * Centralized feature-launch registry.
 *
 * Flip a feature's `launched` flag to gate every route it owns behind a 404
 * ("This feature is not available yet."). Enforcement is compile-time: changing
 * a flag here takes effect on the next build/deploy.
 *
 * How it wires together:
 *  - Controllers tag themselves with `@Feature('<key>')` (see
 *    `src/common/feature.decorator.ts`).
 *  - `LaunchedFeaturesGuard` (a global guard) reads that tag and returns 404
 *    when the feature is not launched.
 *  - `requiredEnv` names environment variables that MUST be present when the
 *    feature is launched or in early access; `env.validation.ts` fails boot
 *    if any are missing.
 *
 * Early access: a feature flagged `earlyAccess: true` stays hidden from
 * everyone while `launched` is false, except members holding a row in
 * `feature_early_access_grants` for its key (granted by admins from the member
 * drawer). `LaunchedFeaturesGuard` lets a signed-in request through for such a
 * feature and `EarlyAccessGuard` checks the grant once the user is known; the
 * per-viewer reads live in `src/early-access/early-access-reads.ts`. Once the
 * feature launches, everyone has it and the grants stop mattering.
 *
 * Other readers of `isFeatureLaunched` answer globally, for every viewer at
 * once (search, saved availability, creator drafts). A future early-access
 * feature that appears in one of them needs per-viewer handling there through
 * `FeatureAccessService`, or its testers never see it in that surface.
 *
 * Only user-facing product features live here. Infrastructure (auth, users,
 * profiles, membership, vouch, security, health, storage, notifications) is
 * always on and is intentionally absent.
 */
export type FeatureConfig = {
  /** Whether the feature's routes are reachable. */
  launched: boolean;
  /**
   * While `launched` is false, members holding an early-access grant for this
   * key may use the feature (routes, sockets, per-viewer reads). Ignored once
   * launched.
   */
  earlyAccess?: boolean;
  /**
   * Env vars that must be set when this feature is launched or in early access
   * (in every environment). Boot fails fast if any is missing while the
   * feature is reachable.
   */
  requiredEnv?: readonly string[];
};

export const launchedFeatures = {
  communities: { launched: true },
  // Companies ships off with the rest of the Work and Economy surface: the
  // member-facing pages (/work/companies and /work/companies/:slug, plus the
  // employer reviews board) are hidden in every production build by
  // COMING_SOON_PATTERNS in the frontend's src/app/authGate.ts, so the API was
  // accepting company creations and employer reviews that no member could
  // reach. The flag now says the same thing the shipped bundle does. Flip back
  // to `launched: true` in the same change that removes /work/companies,
  // /work/employer-reviews and /account/work-profile from COMING_SOON_PATTERNS.
  companies: { launched: false },
  // Jobs ships off for the same reason: the whole board (/work/jobs and every
  // path under it, the poster's index, the apply flow and
  // /work/application-status) is hidden in every production build, while
  // POST /jobs, POST /jobs/:slug/applications and the poster's decision
  // endpoint stayed open to any active member. `GET /search` is untagged and
  // federates twelve resources, so it stays reachable, but it now consults this
  // registry per result type through `search/search-features.ts` and issues no
  // job query at all while this is false. Flip back to `launched: true` in the
  // same change that unhides /work/jobs and /work/application-status.
  jobs: { launched: false },
  partners: { launched: true },
  volunteering: { launched: true },
  // Barter ships off with the Economy column: /work/barter and everything
  // under it (the board, the poster's listings, the proposal inbox) is hidden
  // in every production build, so POST /barter and POST /barter/:id/proposals
  // were taking rows and emitting `barter_proposal_received` notifications
  // whose deep link bounces to /roadmap. Flip back to `launched: true` in the
  // same change that removes /work/barter from COMING_SOON_PATTERNS. The
  // member profile's own "on the board" list is a separate, still-live surface
  // on ProfilesController (PUT /profiles/me/board) and is unaffected.
  barter: { launched: false },
  events: { launched: true },
  // Set to false to hold Go together dark until the DPIA its design names exists.
  goTogether: { launched: true },
  connections: { launched: true },
  messaging: { launched: true },
  forum: { launched: true },
  feed: { launched: true },
  listings: { launched: true },
  housing: { launched: true },
  housingListings: { launched: true },
  flatmateProfiles: { launched: true },
  landlords: { launched: true },
  magazine: { launched: true },
  resources: { launched: true },
  content: { launched: true },
  culture: { launched: true },
  governance: { launched: true },
  community: { launched: true },
  roadmap: { launched: true },
  // Persona podcast-feed import (`/subprofiles/feeds/*`,
  // `/subprofiles/:id/feeds*`) and its scheduled sync. Its own key so the
  // outbound fetching can be switched off without touching personas.
  personaFeedImport: { launched: true },
  // Cinema ships off until Mux is provisioned: launching it makes the Mux
  // credentials below mandatory at boot (see env.validation.ts). Flip to
  // `launched: true` in an environment that has those vars set.
  cinema: {
    launched: false,
    requiredEnv: ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET', 'MUX_WEBHOOK_SECRET'],
  },
  // Studio v1: listening and uploads for members holding a Studio access
  // grant. Every Studio controller is tagged `@Feature('studio')`; the grant
  // itself is checked per request by `StudioAccessGuard`.
  studio: { launched: true },
  // Pulse Live: live quiz and party games on events (`/events/:slug/quizshow*`,
  // `/quizshow/*` and the `/quizshow` socket namespace, whose gateway checks
  // access itself). Hidden from everyone else until the user flips it, after
  // the starter packs are fact-checked
  // (`QUIZSHOW_STARTER_PACKS_ARE_FACT_CHECKED`). Until then, testers holding an
  // early-access grant use it; admins set grants from the member drawer.
  quizshow: { launched: false, earlyAccess: true },
} satisfies Record<string, FeatureConfig>;

export type FeatureKey = keyof typeof launchedFeatures;

export function isFeatureLaunched(key: FeatureKey): boolean {
  return launchedFeatures[key].launched;
}

/** Whether the registry entry opts into early access (launched or not). */
export function isEarlyAccessFeature(key: FeatureKey): boolean {
  const config: FeatureConfig = launchedFeatures[key];
  return config.earlyAccess === true;
}

/** Whether grant holders are the only members who can use the feature today. */
export function isInEarlyAccess(key: FeatureKey): boolean {
  return isEarlyAccessFeature(key) && !isFeatureLaunched(key);
}

/** Every feature currently in early access, in registry order. */
export function earlyAccessFeatureKeys(): FeatureKey[] {
  return (Object.keys(launchedFeatures) as FeatureKey[]).filter((key) =>
    isInEarlyAccess(key),
  );
}

/** Narrows a raw string (a route param, a stored grant row) to a registry key. */
export function isFeatureKey(value: string): value is FeatureKey {
  return Object.prototype.hasOwnProperty.call(launchedFeatures, value);
}

/**
 * Returns human-readable problems for every env var that a reachable feature
 * (launched, or in early access) declares in `requiredEnv` but is missing from
 * `env`. Empty array = all good.
 *
 * Used by `env.validation.ts` to fail boot fast. Takes `features` as a
 * parameter (defaulting to the real registry) so it can be unit-tested against
 * fabricated configs.
 */
export function missingLaunchedFeatureEnv(
  env: Record<string, unknown>,
  features: Record<string, FeatureConfig> = launchedFeatures,
): string[] {
  const problems: string[] = [];
  for (const [key, config] of Object.entries(features)) {
    const isReachable = config.launched || config.earlyAccess === true;
    if (!isReachable) continue;
    for (const name of config.requiredEnv ?? []) {
      const value = env[name];
      if (value === undefined || value === null || value === '') {
        problems.push(
          `${name} is required because the "${key}" feature is launched or in early access ` +
            `(set it in the environment, or set launchedFeatures.${key}.launched = false ` +
            `and drop its earlyAccess flag)`,
        );
      }
    }
  }
  return problems;
}
