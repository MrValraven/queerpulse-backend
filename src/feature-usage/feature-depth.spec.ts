import { launchedFeatures } from '../launchedFeatures';
import {
  FEATURE_DEPTH,
  UNTRACKED_FEATURES,
  isTrackedFeature,
} from './feature-depth';

describe('FEATURE_DEPTH', () => {
  it('covers every launched feature key except the untracked ones, which it leaves out', () => {
    expect(
      [...Object.keys(FEATURE_DEPTH), ...UNTRACKED_FEATURES].sort(),
    ).toEqual(Object.keys(launchedFeatures).sort());
    for (const featureKey of UNTRACKED_FEATURES) {
      expect(Object.keys(FEATURE_DEPTH)).not.toContain(featureKey);
    }
  });

  it('keeps Go together untracked: no reach, no depth, no admin row', () => {
    expect(UNTRACKED_FEATURES).toContain('goTogether');
    expect(isTrackedFeature('goTogether')).toBe(false);
    expect(isTrackedFeature('events')).toBe(true);
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
