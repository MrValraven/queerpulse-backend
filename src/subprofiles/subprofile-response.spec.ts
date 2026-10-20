import {
  toCardDTO,
  toItemView,
  toPublicDTO,
  toSubprofileDTO,
  type SubprofileItemView,
} from './subprofile-response';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import type { FlashDayEventRef } from './flash-day-event-links';
import {
  SubprofileItem,
  SubprofileSection,
  type ItemStructured,
} from './entities/subprofile-item.entity';
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

describe('tattoo item view shaping', () => {
  // Well-formed storage keys (`<prefix>/<owner uuid>/<file uuid><ext>`):
  // `toImageUrl` drops anything that does not parse as one, so a loose
  // stand-in would make the nested ref assertions pass for the wrong reason.
  const ITEM_IMAGE_KEY =
    'work-image/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg';
  const BEFORE_IMAGE_KEY =
    'work-image/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333.jpg';
  const SESSION_IMAGE_KEY =
    'work-image/11111111-1111-1111-1111-111111111111/44444444-4444-4444-4444-444444444444.jpg';

  beforeEach(() => {
    // `toImageUrl` resolves a storage key only once the base URL is wired.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  // The first item view, failing the test outright when the view has none.
  const firstItemOf = (view: {
    items: SubprofileItemView[];
  }): SubprofileItemView => {
    const firstItem = view.items[0];
    if (!firstItem) {
      throw new Error('Expected the view to carry at least one item');
    }
    return firstItem;
  };

  // A published unlinked tattoo persona, with only the fields the mappers read.
  const tattooPersona = (): Subprofile =>
    Object.assign(new Subprofile(), {
      id: 'sp-tattoo-1',
      kind: SubprofileKind.TattooArtist,
      slug: 'inkwell',
      handle: 'inkwell',
      displayName: 'Inkwell',
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
      editVersion: 1,
    });

  const tattooItem = (
    section: SubprofileSection,
    structured: ItemStructured | null,
    imageUrl: string | null = null,
  ): SubprofileItem =>
    Object.assign(new SubprofileItem(), {
      id: 'item-tattoo-1',
      section,
      title: 'Peony sleeve',
      subtitle: null,
      description: null,
      url: null,
      imageUrl,
      date: null,
      meta: null,
      tags: [],
      isFeatured: false,
      collaborators: [],
      position: 0,
      structured,
      createdAt: new Date('2026-10-01T10:00:00.000Z'),
    });

  const membersNight: FlashDayEventRef = {
    slug: 'members-night',
    title: 'Members night flash day',
    startsAt: '2026-11-07T18:00:00.000Z',
    endsAt: null,
    venue: 'Studio Lume',
    neighbourhood: 'Arroios',
    isOnline: false,
    imageUrl: null,
  };

  it('drops hasClientConsent from the public view and keeps isBlurred', () => {
    const item = tattooItem(SubprofileSection.Healed, {
      healed: { healedFor: '2 years' },
      photo: { hasClientConsent: true, isBlurred: true },
    });
    const view = toPublicDTO(tattooPersona(), [item]);
    expect(firstItemOf(view).structured).toEqual({
      healed: { healedFor: '2 years' },
      photo: { isBlurred: true },
    });
    expect(JSON.stringify(view)).not.toContain('hasClientConsent');
  });

  it('blurs a public scar work photo with no stored flag', () => {
    const item = tattooItem(SubprofileSection.ScarWork, {
      scarWork: { type: 'top_surgery' },
    });
    const view = toPublicDTO(tattooPersona(), [item]);
    expect(firstItemOf(view).structured?.photo).toEqual({ isBlurred: true });
  });

  it('shows a public scar work photo sharp when the owner stored isBlurred false', () => {
    const item = tattooItem(SubprofileSection.ScarWork, {
      scarWork: { type: 'top_surgery' },
      photo: { hasClientConsent: true, isBlurred: false },
    });
    const view = toPublicDTO(tattooPersona(), [item]);
    expect(firstItemOf(view).structured?.photo).toEqual({ isBlurred: false });
  });

  it('shows a public legacy healed photo sharp', () => {
    const item = tattooItem(SubprofileSection.Healed, {
      healed: { healedFor: '6 months' },
    });
    const view = toPublicDTO(tattooPersona(), [item]);
    expect(firstItemOf(view).structured?.photo).toEqual({ isBlurred: false });
  });

  it('gives a public body photo item with no stored structured a resolved photo flag', () => {
    const item = tattooItem(SubprofileSection.ScarWork, null);
    const view = toPublicDTO(tattooPersona(), [item]);
    expect(firstItemOf(view).structured).toEqual({
      photo: { isBlurred: true },
    });
  });

  it('drops photo flags from a public item outside the body-photo sections', () => {
    const item = tattooItem(SubprofileSection.Flash, {
      flash: { size: '8 cm' },
      photo: { hasClientConsent: true, isBlurred: false },
    });
    const view = toPublicDTO(tattooPersona(), [item]);
    expect(firstItemOf(view).structured).toEqual({ flash: { size: '8 cm' } });
    expect(JSON.stringify(view)).not.toContain('hasClientConsent');
  });

  it('keeps both photo flags on the owner view', () => {
    const item = tattooItem(SubprofileSection.Healed, {
      healed: { healedFor: '2 years' },
      photo: { hasClientConsent: true, isBlurred: false },
    });
    const view = toSubprofileDTO(tattooPersona(), [item]);
    expect(firstItemOf(view).structured?.photo).toEqual({
      hasClientConsent: true,
      isBlurred: false,
    });
  });

  it('keeps absent flags absent for the owner', () => {
    const item = tattooItem(SubprofileSection.ScarWork, {
      scarWork: { type: 'top_surgery' },
    });
    const view = toSubprofileDTO(tattooPersona(), [item]);
    expect(firstItemOf(view).structured).not.toHaveProperty('photo');
  });

  it('resolves nested image refs through toImageUrl', () => {
    const coverUpItem = tattooItem(
      SubprofileSection.CoverUps,
      {
        coverUp: { type: 'cover_up', beforeImageUrl: BEFORE_IMAGE_KEY },
        photo: { hasClientConsent: true },
      },
      ITEM_IMAGE_KEY,
    );
    const inProgressItem = Object.assign(
      tattooItem(SubprofileSection.InProgress, {
        sessions: [{ imageUrl: SESSION_IMAGE_KEY, note: 'Linework' }],
        photo: { hasClientConsent: true },
      }),
      { id: 'item-tattoo-2' },
    );
    const view = toPublicDTO(tattooPersona(), [coverUpItem, inProgressItem]);
    const coverUpView = view.items.find(
      (itemView) => itemView.id === 'item-tattoo-1',
    );
    const inProgressView = view.items.find(
      (itemView) => itemView.id === 'item-tattoo-2',
    );
    expect(coverUpView?.imageUrl).toBe(toImageUrl(ITEM_IMAGE_KEY));
    expect(coverUpView?.structured?.coverUp?.beforeImageUrl).toBe(
      toImageUrl(BEFORE_IMAGE_KEY),
    );
    expect(coverUpView?.structured?.coverUp?.beforeImageUrl).toBe(
      `https://api.test/files/${BEFORE_IMAGE_KEY}`,
    );
    expect(inProgressView?.structured?.sessions?.[0]).toEqual({
      imageUrl: `https://api.test/files/${SESSION_IMAGE_KEY}`,
      note: 'Linework',
    });
  });

  it('puts linkedEvent on a flash day and keeps its eventSlug while it resolves', () => {
    const item = tattooItem(SubprofileSection.FlashDays, {
      flashDay: {
        eventSlug: 'members-night',
        cause: 'Proceeds to ILGA Portugal',
      },
    });
    const view = toPublicDTO(
      tattooPersona(),
      [item],
      undefined,
      [],
      0,
      false,
      0,
      false,
      [],
      new Map(),
      false,
      new Map(),
      [],
      new Map([['item-tattoo-1', membersNight]]),
    );
    expect(firstItemOf(view).linkedEvent).toEqual(membersNight);
    expect(firstItemOf(view).structured?.flashDay).toEqual({
      eventSlug: 'members-night',
      cause: 'Proceeds to ILGA Portugal',
    });
  });

  it('removes eventSlug and sets linkedEvent null when the event does not resolve', () => {
    const item = tattooItem(SubprofileSection.FlashDays, {
      flashDay: {
        eventSlug: 'members-night',
        cause: 'Proceeds to ILGA Portugal',
      },
    });
    const view = toPublicDTO(
      tattooPersona(),
      [item],
      undefined,
      [],
      0,
      false,
      0,
      false,
      [],
      new Map(),
      false,
      new Map(),
      [],
      new Map(),
    );
    expect(firstItemOf(view).linkedEvent).toBeNull();
    expect(firstItemOf(view).structured?.flashDay).toEqual({
      cause: 'Proceeds to ILGA Portugal',
    });
    expect(JSON.stringify(view)).not.toContain('members-night');
  });

  it('carries the linked event on the owner view of a flash day', () => {
    const item = tattooItem(SubprofileSection.FlashDays, {
      flashDay: { eventSlug: 'members-night' },
    });
    const view = toSubprofileDTO(
      tattooPersona(),
      [item],
      [],
      0,
      0,
      [],
      new Map(),
      1,
      new Map(),
      undefined,
      new Map([['item-tattoo-1', membersNight]]),
    );
    expect(firstItemOf(view).linkedEvent).toEqual(membersNight);
    expect(firstItemOf(view).structured?.flashDay).toEqual({
      eventSlug: 'members-night',
    });
  });

  it('sets linkedEvent null and removes eventSlug on the owner view when the event does not resolve', () => {
    const item = tattooItem(SubprofileSection.FlashDays, {
      flashDay: {
        eventSlug: 'members-night',
        cause: 'Proceeds to ILGA Portugal',
      },
    });
    const view = toSubprofileDTO(
      tattooPersona(),
      [item],
      [],
      0,
      0,
      [],
      new Map(),
      1,
      new Map(),
      undefined,
      new Map(),
    );
    expect(firstItemOf(view).linkedEvent).toBeNull();
    expect(firstItemOf(view).structured?.flashDay).toEqual({
      cause: 'Proceeds to ILGA Portugal',
    });
    expect(JSON.stringify(view)).not.toContain('members-night');
  });

  it('leaves linkedEvent off items in other sections', () => {
    const item = tattooItem(SubprofileSection.Flash, {
      flash: { size: '8 cm' },
    });
    const view = toPublicDTO(tattooPersona(), [item]);
    expect('linkedEvent' in firstItemOf(view)).toBe(false);
  });

  it('leaves the stored item untouched', () => {
    const item = tattooItem(
      SubprofileSection.CoverUps,
      {
        coverUp: { type: 'rework', beforeImageUrl: BEFORE_IMAGE_KEY },
        photo: { hasClientConsent: true, isBlurred: true },
      },
      ITEM_IMAGE_KEY,
    );
    const flashDayItem = Object.assign(
      tattooItem(SubprofileSection.FlashDays, {
        flashDay: { eventSlug: 'members-night', cause: 'Mutual aid' },
      }),
      { id: 'item-tattoo-2' },
    );
    const storedCopy = structuredClone(item);
    const storedFlashDayCopy = structuredClone(flashDayItem);
    toPublicDTO(tattooPersona(), [item, flashDayItem]);
    toSubprofileDTO(tattooPersona(), [item, flashDayItem]);
    expect(item).toEqual(storedCopy);
    expect(flashDayItem).toEqual(storedFlashDayCopy);
  });
});
