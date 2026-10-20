import {
  FeatureConfig,
  earlyAccessFeatureKeys,
  isEarlyAccessFeature,
  isFeatureKey,
  isFeatureLaunched,
  isInEarlyAccess,
  launchedFeatures,
  missingLaunchedFeatureEnv,
} from './launchedFeatures';

describe('launchedFeatures registry', () => {
  it('reports every configured feature through isFeatureLaunched', () => {
    for (const key of Object.keys(launchedFeatures) as Array<
      keyof typeof launchedFeatures
    >) {
      expect(isFeatureLaunched(key)).toBe(launchedFeatures[key].launched);
    }
  });

  // PRD-422: Go together has its own key and ships on. Flipping it off holds
  // the feature dark; update this expectation in the same change.
  it('ships Go together launched under its own key', () => {
    expect(isFeatureLaunched('goTogether')).toBe(true);
  });

  it('ships Studio launched under its own key', () => {
    expect(isFeatureLaunched('studio')).toBe(true);
  });

  it('ships cinema disabled (its Mux env is not provisioned by default)', () => {
    expect(isFeatureLaunched('cinema')).toBe(false);
  });

  it('ships Pulse Live hidden until the user flips it', () => {
    expect(isFeatureLaunched('quizshow')).toBe(false);
  });

  // The Work and Economy surface is hidden in every production build by
  // COMING_SOON_PATTERNS (frontend src/app/authGate.ts), so these three keys
  // must stay off: leaving them on means the API accepts job posts,
  // applications, company reviews and barter proposals that no member has a
  // surface to reach. Flip these expectations in the same change that unhides
  // /work/jobs, /work/companies and /work/barter in the frontend gate.
  it.each(['companies', 'jobs', 'barter'] as const)(
    'ships %s disabled while its member-facing surface is hidden',
    (key) => {
      expect(isFeatureLaunched(key)).toBe(false);
    },
  );
});

describe('early access helpers', () => {
  it('flags Pulse Live for early access while it is unlaunched', () => {
    expect(isEarlyAccessFeature('quizshow')).toBe(true);
    expect(isInEarlyAccess('quizshow')).toBe(true);
  });

  it('leaves a launched feature without the flag out of early access', () => {
    expect(isEarlyAccessFeature('studio')).toBe(false);
    expect(isInEarlyAccess('studio')).toBe(false);
  });

  it('leaves an unlaunched feature without the flag out of early access', () => {
    expect(isEarlyAccessFeature('cinema')).toBe(false);
    expect(isInEarlyAccess('cinema')).toBe(false);
  });

  // The frontend mirrors this list in `shared/contracts/earlyAccess.ts`
  // (`EARLY_ACCESS_FEATURE_KEYS`); update both in the same change.
  it('lists exactly the features in early access, in registry order', () => {
    expect(earlyAccessFeatureKeys()).toEqual(['quizshow']);
  });

  it('lists only keys whose entry is flagged and unlaunched', () => {
    for (const key of earlyAccessFeatureKeys()) {
      expect(launchedFeatures[key].launched).toBe(false);
      expect(isEarlyAccessFeature(key)).toBe(true);
    }
  });

  it('recognises every registry key as a feature key', () => {
    for (const key of Object.keys(launchedFeatures)) {
      expect(isFeatureKey(key)).toBe(true);
    }
  });

  it('rejects unknown strings and inherited object properties', () => {
    expect(isFeatureKey('retired-feature')).toBe(false);
    expect(isFeatureKey('')).toBe(false);
    expect(isFeatureKey('toString')).toBe(false);
    expect(isFeatureKey('__proto__')).toBe(false);
  });
});

describe('missingLaunchedFeatureEnv', () => {
  const features: Record<string, FeatureConfig> = {
    alpha: { launched: true, requiredEnv: ['ALPHA_KEY'] },
    beta: { launched: false, requiredEnv: ['BETA_KEY'] },
    gamma: { launched: true },
  };

  it('flags a launched feature whose required var is missing', () => {
    const problems = missingLaunchedFeatureEnv({}, features);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ALPHA_KEY');
    expect(problems[0]).toContain('alpha');
  });

  it('treats an empty string as missing', () => {
    expect(missingLaunchedFeatureEnv({ ALPHA_KEY: '' }, features)).toHaveLength(
      1,
    );
  });

  it('passes when the launched feature has its var set', () => {
    expect(missingLaunchedFeatureEnv({ ALPHA_KEY: 'x' }, features)).toEqual([]);
  });

  it('ignores required vars of a disabled feature', () => {
    // beta is disabled, so its missing BETA_KEY must not be reported.
    expect(missingLaunchedFeatureEnv({ ALPHA_KEY: 'x' }, features)).toEqual([]);
  });

  it('ignores features that declare no requiredEnv', () => {
    expect(missingLaunchedFeatureEnv({ ALPHA_KEY: 'x' }, features)).toEqual([]);
  });

  it('flags an unlaunched feature in early access whose required var is missing', () => {
    const earlyAccessFeatures: Record<string, FeatureConfig> = {
      delta: { launched: false, earlyAccess: true, requiredEnv: ['DELTA_KEY'] },
    };
    const problems = missingLaunchedFeatureEnv({}, earlyAccessFeatures);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('DELTA_KEY');
    expect(problems[0]).toContain(
      'because the "delta" feature is launched or in early access',
    );
  });

  it('passes an early-access feature that has its var set', () => {
    const earlyAccessFeatures: Record<string, FeatureConfig> = {
      delta: { launched: false, earlyAccess: true, requiredEnv: ['DELTA_KEY'] },
    };
    expect(
      missingLaunchedFeatureEnv({ DELTA_KEY: 'x' }, earlyAccessFeatures),
    ).toEqual([]);
  });

  it('ignores an unlaunched feature whose earlyAccess flag is false', () => {
    const closedFeatures: Record<string, FeatureConfig> = {
      epsilon: {
        launched: false,
        earlyAccess: false,
        requiredEnv: ['EPSILON_KEY'],
      },
    };
    expect(missingLaunchedFeatureEnv({}, closedFeatures)).toEqual([]);
  });

  it('is a no-op against the real registry when no launched feature needs env', () => {
    // cinema (the only requiredEnv feature) ships disabled, so an env with no
    // Mux vars must validate clean.
    expect(missingLaunchedFeatureEnv({})).toEqual([]);
  });
});
