import {
  FeatureConfig,
  isFeatureLaunched,
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

  it('ships cinema disabled (its Mux env is not provisioned by default)', () => {
    expect(isFeatureLaunched('cinema')).toBe(false);
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

  it('is a no-op against the real registry when no launched feature needs env', () => {
    // cinema (the only requiredEnv feature) ships disabled, so an env with no
    // Mux vars must validate clean.
    expect(missingLaunchedFeatureEnv({})).toEqual([]);
  });
});
