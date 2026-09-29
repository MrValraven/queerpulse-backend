import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  BLOCKED_TERMS,
  MIN_BIO,
  validatePublish,
} from './subprofile-validation';

// M6 (fix round 1): ENG-453 added `tagline` to the publish-time blocked-term
// screen (`containsBlockedTerm` in `subprofile-validation.ts`), matching the
// live-edit re-screen in `subprofiles.service.ts` (`update`, the
// `prevStatus === Published` block). Nothing covered a blocked term
// appearing ONLY in the tagline before this file; the fixture mirrors
// `subprofiles.service.spec.ts`'s own `completeUnlinked` helper so a clean
// name, bio and handle isolate the tagline as the one variable under test.

function completeUnlinked(overrides: Partial<Subprofile> = {}): Subprofile {
  return Object.assign(new Subprofile(), {
    id: 'sp-1',
    userId: 'user-1',
    kind: SubprofileKind.Developer,
    slug: 'nightform',
    handle: 'nightform',
    displayName: 'Nightform',
    avatarUrl: 'https://cdn/a.png',
    tagline: null,
    bio: 'x'.repeat(MIN_BIO),
    coverUrl: null,
    accent: null,
    availability: null,
    ctaLabel: null,
    ctaUrl: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    visibility: SubprofileVisibility.Open,
    status: SubprofileStatus.Draft,
    position: 0,
    skinData: null,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

describe('validatePublish tagline screen (ENG-453)', () => {
  it('flags blocked_terms when a blocked term appears only in the tagline', () => {
    // References the real centrally-managed blocklist by index, keeping no
    // slur spelled out in the test source, matching the convention
    // `subprofiles.service.spec.ts`'s own blocked-term tests already use: the
    // term appears as a standalone word so the word-boundary matcher fires.
    const sp = completeUnlinked({ tagline: `hi, ${BLOCKED_TERMS[0]}` });
    expect(validatePublish(sp, [])).toContain('blocked_terms');
  });

  it('does not flag a persona with a clean name, bio, handle and tagline', () => {
    const sp = completeUnlinked({ tagline: 'a very normal tagline' });
    expect(validatePublish(sp, [])).toEqual([]);
  });
});
