import { launchedFeatures, type FeatureConfig } from '../launchedFeatures';
import { SearchResultType } from './dto/search.query';
import {
  RESULT_TYPE_FEATURE,
  isResultTypeLaunched,
  launchedResultTypes,
} from './search-features';

// Fabricated registries, the same seam `missingLaunchedFeatureEnv` uses: the
// gate has to be provable without depending on which features happen to be
// open in `launchedFeatures.ts` today.
const everyFeatureOn: Record<string, FeatureConfig> = Object.fromEntries(
  Object.values(RESULT_TYPE_FEATURE)
    .filter(
      (feature): feature is NonNullable<typeof feature> => feature !== null,
    )
    .map((feature) => [feature, { launched: true }]),
);

const withFeatureClosed = (closed: string): Record<string, FeatureConfig> => ({
  ...everyFeatureOn,
  [closed]: { launched: false },
});

const allResultTypes = Object.values(SearchResultType);

describe('RESULT_TYPE_FEATURE', () => {
  it('declares a feature (or infrastructure) for every result type', () => {
    for (const resultType of allResultTypes) {
      expect(Object.keys(RESULT_TYPE_FEATURE)).toContain(resultType);
    }
  });

  it('names only keys that exist in the real launch registry', () => {
    for (const feature of Object.values(RESULT_TYPE_FEATURE)) {
      if (feature === null) continue;
      expect(Object.keys(launchedFeatures)).toContain(feature);
    }
  });
});

describe('isResultTypeLaunched', () => {
  it('allows every result type when every feature is launched', () => {
    for (const resultType of allResultTypes) {
      expect(isResultTypeLaunched(resultType, everyFeatureOn)).toBe(true);
    }
  });

  it('suppresses exactly the result types belonging to a closed feature', () => {
    const registry = withFeatureClosed('jobs');

    expect(isResultTypeLaunched(SearchResultType.Job, registry)).toBe(false);
    for (const resultType of allResultTypes) {
      if (RESULT_TYPE_FEATURE[resultType] === 'jobs') continue;
      expect(isResultTypeLaunched(resultType, registry)).toBe(true);
    }
  });

  it('suppresses both forum types together, since they share one feature', () => {
    const registry = withFeatureClosed('forum');

    expect(isResultTypeLaunched(SearchResultType.Forum, registry)).toBe(false);
    expect(isResultTypeLaunched(SearchResultType.ForumPost, registry)).toBe(
      false,
    );
    expect(isResultTypeLaunched(SearchResultType.Community, registry)).toBe(
      true,
    );
  });

  it('keeps the infrastructure-backed types searchable whatever the registry says', () => {
    // Empty registry: no flag exists for anything.
    expect(isResultTypeLaunched(SearchResultType.Member, {})).toBe(true);
    expect(isResultTypeLaunched(SearchResultType.Subprofile, {})).toBe(true);
  });

  it('fails shut on a feature key the registry does not carry', () => {
    for (const resultType of allResultTypes) {
      if (RESULT_TYPE_FEATURE[resultType] === null) continue;
      expect(isResultTypeLaunched(resultType, {})).toBe(false);
    }
  });
});

describe('launchedResultTypes', () => {
  // The whole point of the list is that a client can trust it to say exactly
  // what a search will answer with, so it is asserted in BOTH directions
  // against every result type: present implies searchable, absent implies not.
  const expectAgreesWithGate = (
    features: Record<string, FeatureConfig>,
  ): void => {
    const exposed = new Set<SearchResultType>(launchedResultTypes(features));
    for (const resultType of allResultTypes) {
      expect({ resultType, isExposed: exposed.has(resultType) }).toEqual({
        resultType,
        isExposed: isResultTypeLaunched(resultType, features),
      });
    }
  };

  it('agrees with the gate on every type when every feature is launched', () => {
    expectAgreesWithGate(everyFeatureOn);
    expect(launchedResultTypes(everyFeatureOn)).toEqual(allResultTypes);
  });

  it('agrees with the gate on every type when a feature is closed', () => {
    expectAgreesWithGate(withFeatureClosed('jobs'));
  });

  it('drops exactly the closed feature, keeping every other type', () => {
    const exposed = launchedResultTypes(withFeatureClosed('jobs'));

    expect(exposed).not.toContain(SearchResultType.Job);
    expect(exposed).toEqual(
      allResultTypes.filter(
        (resultType) => RESULT_TYPE_FEATURE[resultType] !== 'jobs',
      ),
    );
  });

  it('drops both forum types together, since they share one feature', () => {
    const exposed = launchedResultTypes(withFeatureClosed('forum'));

    expect(exposed).not.toContain(SearchResultType.Forum);
    expect(exposed).not.toContain(SearchResultType.ForumPost);
    expect(exposed).toContain(SearchResultType.Community);
  });

  it('keeps only the infrastructure-backed types against an empty registry', () => {
    // Fails shut, the same way the gate does: an unknown feature key reads as
    // closed, so a client is never offered a category with no data behind it.
    expect(launchedResultTypes({})).toEqual([
      SearchResultType.Member,
      SearchResultType.Subprofile,
    ]);
  });

  it('agrees with the gate against the real registry, whatever it says today', () => {
    expectAgreesWithGate(launchedFeatures);
  });
});
