import { COMMUNITY_TAGS } from '../communities/community-tags';
import {
  COMMUNITY_TAG_SENSITIVITY,
  ContentSensitivity,
  communityTagsFor,
  excludedContentTags,
  itemTagsFor,
  NO_EXCLUDED_CONTENT_TAGS,
  optedOutSensitivities,
} from './content-sensitivity';

describe('content sensitivity classification (PRD-10)', () => {
  // The anti-drift guarantee, asserted as well as typed. The `Record` keyed by
  // `CommunityTag` already makes a missing entry a compile error, and this
  // catches the one way past that: a cast, or a taxonomy read at runtime from
  // somewhere the type never saw.
  it('classifies every tag in the community taxonomy, and nothing else', () => {
    const classified = Object.keys(COMMUNITY_TAG_SENSITIVITY).sort();
    expect(classified).toEqual([...COMMUNITY_TAGS].sort());
  });

  it('only ever assigns one of the three sensitivities, or none', () => {
    const allowed = new Set<ContentSensitivity | null>([
      ContentSensitivity.Dating,
      ContentSensitivity.MentalHealth,
      ContentSensitivity.SexualityIdentity,
      null,
    ]);
    for (const value of Object.values(COMMUNITY_TAG_SENSITIVITY)) {
      expect(allowed.has(value)).toBe(true);
    }
  });

  // The three switches must be able to hide something, or they are the same
  // inert placeholder in a new place.
  it.each([
    ContentSensitivity.Dating,
    ContentSensitivity.MentalHealth,
    ContentSensitivity.SexualityIdentity,
  ])('has at least one tag classified as %s', (sensitivity) => {
    expect(communityTagsFor([sensitivity]).length).toBeGreaterThan(0);
  });

  // Documented abstentions. These are decisions, so they get a test: a later
  // edit that quietly sweeps healthcare or a racialised-members room into a
  // content filter should have to delete an assertion that says why not.
  it.each([
    'bipoc-led',
    'disability-chronic-illness',
    'neurodivergent',
    'deaf-hard-of-hearing',
    'hiv-wellness',
    'trans-health-medical',
    'sex-worker-allies',
  ] as const)('leaves %s unclassified on purpose', (tag) => {
    expect(COMMUNITY_TAG_SENSITIVITY[tag]).toBeNull();
  });
});

describe('communityTagsFor', () => {
  it('returns nothing when nothing is opted out', () => {
    expect(communityTagsFor([])).toEqual([]);
  });

  it('returns the tags of every requested sensitivity, in taxonomy order', () => {
    const tags = communityTagsFor([
      ContentSensitivity.Dating,
      ContentSensitivity.MentalHealth,
    ]);
    expect(tags).toContain('mental-health');
    expect(tags).toContain('polyamory-enm');
    expect(tags).not.toContain('trans-nonbinary');
    // Same relative order as the taxonomy, so the predicate a reviewer reads
    // in a query log lines up with the file.
    const ordered = COMMUNITY_TAGS.filter((tag) => tags.includes(tag));
    expect(tags).toEqual([...ordered]);
  });
});

describe('itemTagsFor', () => {
  // Forum tags are freeform text a member typed. Somebody who asked not to see
  // mental-health content means `#mentalhealth` as much as `mental-health`,
  // and deriving the alias keeps the two spellings from drifting apart.
  it('adds the hyphen-free spelling of every classified tag', () => {
    const tags = itemTagsFor([ContentSensitivity.MentalHealth]);
    expect(tags).toContain('mental-health');
    expect(tags).toContain('mentalhealth');
  });

  it('does not duplicate single-word tags', () => {
    const tags = itemTagsFor([ContentSensitivity.SexualityIdentity]);
    expect(tags.filter((tag) => tag === 'intersex')).toHaveLength(1);
  });
});

describe('optedOutSensitivities', () => {
  it('reads each switch independently', () => {
    expect(
      optedOutSensitivities({
        hideDatingContent: false,
        hideMentalHealthContent: true,
        hideSexualityIdentityContent: true,
      }),
    ).toEqual([
      ContentSensitivity.MentalHealth,
      ContentSensitivity.SexualityIdentity,
    ]);
  });
});

describe('excludedContentTags', () => {
  // A member with no preferences row, which is most of them.
  it('excludes nothing for a member with no stored choices', () => {
    expect(excludedContentTags(null)).toBe(NO_EXCLUDED_CONTENT_TAGS);
  });

  it('excludes nothing when all three switches are on', () => {
    expect(
      excludedContentTags({
        hideDatingContent: false,
        hideMentalHealthContent: false,
        hideSexualityIdentityContent: false,
      }),
    ).toBe(NO_EXCLUDED_CONTENT_TAGS);
  });

  it('resolves one switch into both tag sets', () => {
    const excluded = excludedContentTags({
      hideDatingContent: false,
      hideMentalHealthContent: true,
      hideSexualityIdentityContent: false,
    });
    expect(excluded.communityTags).toContain('mental-health');
    expect(excluded.itemTags).toEqual(
      expect.arrayContaining(['mental-health', 'mentalhealth']),
    );
    // The community set stays the curated vocabulary: aliases belong only to
    // the freeform side, where a member typed the tag themselves.
    expect(excluded.communityTags).not.toContain('mentalhealth');
  });
});
