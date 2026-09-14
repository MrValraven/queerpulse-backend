import { launchedFeatures } from '../launchedFeatures';
import { FEATURE_DEPTH } from './feature-depth';

describe('FEATURE_DEPTH', () => {
  it('covers every launched feature key', () => {
    expect(Object.keys(FEATURE_DEPTH).sort()).toEqual(
      Object.keys(launchedFeatures).sort(),
    );
  });

  it('gives every reach-only feature a stated reason', () => {
    for (const [featureKey, spec] of Object.entries(FEATURE_DEPTH)) {
      if (spec.kind === 'reach-only') {
        expect(spec.reason.length).toBeGreaterThan(0);
      } else {
        expect(spec.entities.length).toBeGreaterThan(0);
        expect(featureKey).toBeTruthy();
      }
    }
  });
});
