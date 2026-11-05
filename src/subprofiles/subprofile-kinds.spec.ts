import {
  FAMILY_OF_KIND,
  KIND_SECTIONS,
  isSectionVisibleForKind,
  visibleItemsForKind,
  type SubprofileKind,
  type SubprofileSection,
} from './subprofile-kinds';

describe('FAMILY_OF_KIND', () => {
  it('maps every kind in KIND_SECTIONS to a family', () => {
    expect(Object.keys(FAMILY_OF_KIND).sort()).toEqual(
      Object.keys(KIND_SECTIONS).sort(),
    );
  });

  it.each([
    ['musician', 'stage'],
    ['dj', 'stage'],
    ['drag', 'stage'],
    ['podcaster', 'stage'],
    ['ceramicist', 'workshop'],
    ['generic', 'workshop'],
    ['game_designer', 'quest'],
    ['fanfic_writer', 'page'],
    ['tattoo_artist', 'studio'],
    ['therapist', 'practice'],
    ['coach', 'practice'],
    ['astrologer', 'chart'],
    ['pole_dancer', 'stage'],
  ])('puts %s in the %s family', (kind, family) => {
    expect(FAMILY_OF_KIND[kind as SubprofileKind]).toBe(family);
  });
});

describe('isSectionVisibleForKind', () => {
  it('shows a section the kind uses', () => {
    expect(isSectionVisibleForKind('musician', 'discography')).toBe(true);
  });

  it('hides a section the kind does not use', () => {
    expect(isSectionVisibleForKind('dj', 'discography')).toBe(false);
  });

  it.each(Object.keys(KIND_SECTIONS))(
    'always shows gallery and links for %s',
    (kind) => {
      expect(isSectionVisibleForKind(kind as SubprofileKind, 'gallery')).toBe(
        true,
      );
      expect(isSectionVisibleForKind(kind as SubprofileKind, 'links')).toBe(
        true,
      );
    },
  );
});

describe('visibleItemsForKind', () => {
  it('keeps visible items in input order and leaves the input untouched', () => {
    const items = [
      { section: 'discography' },
      { section: 'mixes' },
      { section: 'gallery' },
      { section: 'links' },
    ] as { section: SubprofileSection }[];
    expect(
      visibleItemsForKind('dj', items).map((item) => item.section),
    ).toEqual(['mixes', 'gallery', 'links']);
    expect(items).toHaveLength(4);
  });
});
