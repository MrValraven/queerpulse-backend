import {
  toCardDTO,
  toItemView,
  toPublicDTO,
  toSubprofileDTO,
} from './subprofile-response';
import { SubprofileItem } from './entities/subprofile-item.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';

describe('toItemView', () => {
  it('exposes createdAt as an ISO string', () => {
    const item = Object.assign(new SubprofileItem(), {
      id: 'item-1',
      section: 'poems',
      title: 'Pecado',
      structured: { poem: [] },
      createdAt: new Date('2025-07-14T09:32:00.000Z'),
    });
    const view = toItemView(item, new Map());
    expect(view.createdAt).toBe('2025-07-14T09:32:00.000Z');
  });
});

describe('toCardDTO table summary', () => {
  // A Quest persona (game master), built the way this file builds its other
  // entity fixtures (`Object.assign(new ..., {...})`, only the fields
  // `toCardDTO` actually reads).
  const questRow = Object.assign(new Subprofile(), {
    id: 'sp-quest-1',
    handle: 'thedm',
    kind: SubprofileKind.GameMaster,
    displayName: 'The DM',
    avatarUrl: null,
    coverUrl: null,
    tagline: null,
    accent: null,
    availability: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    slug: 'thedm',
  });

  it('carries the table summary only when one is passed', () => {
    const card = toCardDTO(questRow, 0, [], 0, null, new Map(), null, {
      format: 'online',
      vibe: ['queer_led'],
    });
    expect(card.table).toEqual({ format: 'online', vibe: ['queer_led'] });
    expect(toCardDTO(questRow).table).toBeUndefined();
  });
});

describe('toPublicDTO visibility', () => {
  // Only the fields `toPublicDTO` reads, built the way this file builds its
  // other entity fixtures.
  const publicRow = (visibility: SubprofileVisibility): Subprofile =>
    Object.assign(new Subprofile(), {
      id: 'sp-public-1',
      kind: SubprofileKind.Developer,
      slug: 'nightform',
      handle: 'nightform',
      displayName: 'Nightform',
      avatarUrl: null,
      tagline: null,
      bio: null,
      coverUrl: null,
      accent: null,
      availability: null,
      ctaLabel: null,
      ctaUrl: null,
      linkVisibility: SubprofileLinkVisibility.Unlinked,
      visibility,
      status: SubprofileStatus.Published,
      skinData: null,
    });

  it('carries an open persona as open', () => {
    const view = toPublicDTO(publicRow(SubprofileVisibility.Open), []);
    expect(view.visibility).toBe(SubprofileVisibility.Open);
  });

  it('carries a members-only persona as network, so the page can hide Follow and Endorse', () => {
    const view = toPublicDTO(publicRow(SubprofileVisibility.Network), []);
    expect(view.visibility).toBe(SubprofileVisibility.Network);
  });
});

describe('editVersion (ENG-451)', () => {
  const editedRow = (editVersion?: number): Subprofile =>
    Object.assign(new Subprofile(), {
      id: 'sp-edited-1',
      kind: SubprofileKind.Developer,
      slug: 'nightform',
      handle: 'nightform',
      displayName: 'Nightform',
      avatarUrl: null,
      tagline: null,
      bio: null,
      coverUrl: null,
      accent: null,
      availability: null,
      ctaLabel: null,
      ctaUrl: null,
      linkVisibility: SubprofileLinkVisibility.Unlinked,
      visibility: SubprofileVisibility.Open,
      status: SubprofileStatus.Published,
      position: 0,
      skinData: null,
      editVersion,
    });

  it('carries the stored edit version on the owner view', () => {
    expect(toSubprofileDTO(editedRow(7), []).editVersion).toBe(7);
  });

  it('reads a row with no stored value yet as version 0 on the owner view', () => {
    expect(toSubprofileDTO(editedRow(), []).editVersion).toBe(0);
  });

  it('keeps the edit version off the public view', () => {
    expect(toPublicDTO(editedRow(7), [])).not.toHaveProperty('editVersion');
  });
});
