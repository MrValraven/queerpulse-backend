/**
 * Centralized feature-launch registry.
 *
 * Flip a feature's `launched` flag to gate every route it owns behind a 404
 * ("This feature is not available yet."). Enforcement is compile-time: changing
 * a flag here takes effect on the next build/deploy, not at runtime.
 *
 * How it wires together:
 *  - Controllers tag themselves with `@Feature('<key>')` (see
 *    `src/common/feature.decorator.ts`).
 *  - `LaunchedFeaturesGuard` (a global guard) reads that tag and returns 404
 *    when the feature is not launched.
 *  - `requiredEnv` names environment variables that MUST be present when the
 *    feature is launched; `env.validation.ts` fails boot if any are missing.
 *
 * Only user-facing product features live here. Infrastructure (auth, users,
 * profiles, membership, vouch, security, health, storage, notifications) is
 * always on and is intentionally absent.
 */
export type FeatureConfig = {
  /** Whether the feature's routes are reachable. */
  launched: boolean;
  /**
   * Env vars that must be set when this feature is launched (in every
   * environment). Boot fails fast if any is missing while `launched` is true.
   */
  requiredEnv?: readonly string[];
};

export const launchedFeatures = {
  communities: { launched: true },
  companies: { launched: true },
  jobs: { launched: true },
  partners: { launched: true },
  volunteering: { launched: true },
  events: { launched: true },
  connections: { launched: true },
  messaging: { launched: true },
  forum: { launched: true },
  feed: { launched: true },
  listings: { launched: true },
  magazine: { launched: true },
  resources: { launched: true },
  content: { launched: true },
  // Cinema ships off until Mux is provisioned: launching it makes the Mux
  // credentials below mandatory at boot (see env.validation.ts). Flip to
  // `launched: true` in an environment that has those vars set.
  cinema: {
    launched: false,
    requiredEnv: ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET', 'MUX_WEBHOOK_SECRET'],
  },
} satisfies Record<string, FeatureConfig>;

export type FeatureKey = keyof typeof launchedFeatures;

export function isFeatureLaunched(key: FeatureKey): boolean {
  return launchedFeatures[key].launched;
}

/**
 * Returns human-readable problems for every env var that a *launched* feature
 * declares in `requiredEnv` but is missing from `env`. Empty array = all good.
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
    if (!config.launched) continue;
    for (const name of config.requiredEnv ?? []) {
      const value = env[name];
      if (value === undefined || value === null || value === '') {
        problems.push(
          `${name} is required because the "${key}" feature is launched ` +
            `(set it in the environment, or set launchedFeatures.${key}.launched = false)`,
        );
      }
    }
  }
  return problems;
}
