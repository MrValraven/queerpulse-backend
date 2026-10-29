import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { LISTING_DRAFT_BUSINESS_KEYS } from '../listing-drafts/listing-draft-response';
import {
  EVENT_DRAFT_PREVIEW_KEYS,
  LISTING_DRAFT_PREVIEW_KEYS,
  toCommunityDraftPreview,
  toEventDraftPreview,
  toListingDraftPreview,
} from './creator-draft-public-fields';

const OWNER_ID = '11111111-2222-3333-4444-555555555555';
const FILE_ID = '66666666-7777-8888-9999-000000000000';
const WIDE_KEY = `listing-photos/${OWNER_ID}/${FILE_ID}.jpg`;
const COVER_KEY = `listing-covers/${OWNER_ID}/${FILE_ID}.jpg`;
const MUG_KEY = `listing-photos/${OWNER_ID}/22222222-7777-8888-9999-000000000000.jpg`;
const COMMUNITY_COVER_KEY = `community-covers/${OWNER_ID}/${FILE_ID}.jpg`;
const FILES_BASE = 'https://api.queerpulse.test/files';

beforeAll(() => setImageUrlBase('https://api.queerpulse.test'));
afterAll(resetImageUrlBaseForTesting);

describe('toEventDraftPreview', () => {
  it('drops every excluded event field and a key nobody listed', () => {
    const preview = toEventDraftPreview(
      {
        title: 'Queer book swap',
        address: 'Rua 1',
        directions: 'Second door',
        onlineUrl: 'https://meet.test/x',
        venueListingId: 'listing-1',
        runByListingId: 'listing-2',
        isCapTouched: true,
        isAttendeeCountTouched: true,
        isRsvpCutoffTouched: true,
        guestListNotes: 'private',
        cap: '30',
      },
      {
        community: { slug: 'lisbon-readers', name: 'Lisbon Readers' },
        runByListing: null,
      },
    );
    expect(preview).toEqual({
      title: 'Queer book swap',
      cap: '30',
      community: { slug: 'lisbon-readers', name: 'Lisbon Readers' },
      runByListing: null,
    });
  });

  it('keeps the listed keys a stored snapshot carries', () => {
    const snapshot = Object.fromEntries(
      EVENT_DRAFT_PREVIEW_KEYS.map((key) => [key, `value-${key}`]),
    );
    const preview = toEventDraftPreview(snapshot, {
      community: null,
      runByListing: null,
    });
    expect(Object.keys(preview).sort()).toEqual(
      [...EVENT_DRAFT_PREVIEW_KEYS, 'community', 'runByListing'].sort(),
    );
  });

  it('rebuilds venueListing from slug and name only', () => {
    const preview = toEventDraftPreview(
      { venueListing: { slug: 's', name: 'V', address: 'x', latitude: 1 } },
      { community: null, runByListing: null },
    );
    expect(preview.venueListing).toEqual({ slug: 's', name: 'V' });
    const junk = toEventDraftPreview(
      { venueListing: 'raw' },
      { community: null, runByListing: null },
    );
    expect(junk.venueListing).toBeNull();
  });

  it('lists exactly 35 event keys', () => {
    expect(EVENT_DRAFT_PREVIEW_KEYS).toHaveLength(35);
  });
});

describe('toListingDraftPreview', () => {
  it('hands back only preview keys from the draft envelope and resolves every image', () => {
    const preview = toListingDraftPreview({
      step: 3,
      baseline: 'fingerprint',
      draft: {
        name: 'Café Arco',
        ownerBio: 'mine',
        consentOuting: true,
        rel: 'owner',
        badge: 'queer_owned',
        photos: {
          wide: WIDE_KEY,
          d1: '',
          d2: 'javascript:alert(1)',
          vibe: 'https://images.test/v.jpg',
        },
        coverPhoto: { image: COVER_KEY, alt: 'The counter' },
        shopItems: [
          {
            id: 's1',
            name: 'Mug',
            price: '8',
            link: '',
            photo: { image: MUG_KEY },
          },
        ],
      },
    });
    expect(preview).toEqual({
      name: 'Café Arco',
      photos: {
        wide: `${FILES_BASE}/${WIDE_KEY}`,
        d1: null,
        d2: null,
        vibe: 'https://images.test/v.jpg',
      },
      coverPhoto: { image: `${FILES_BASE}/${COVER_KEY}`, alt: 'The counter' },
      shopItems: [
        {
          id: 's1',
          name: 'Mug',
          price: '8',
          link: '',
          photo: {
            image: `${FILES_BASE}/${MUG_KEY}`,
            alt: '',
            caption: '',
          },
        },
      ],
    });
  });

  it('lists coverPhoto beside every business key', () => {
    expect(LISTING_DRAFT_PREVIEW_KEYS).toEqual([
      ...LISTING_DRAFT_BUSINESS_KEYS,
      'coverPhoto',
    ]);
  });

  it('resolves a menu file key and nulls a file whose url cannot resolve', () => {
    const menuKey = `listing-menus/${OWNER_ID}/${FILE_ID}.pdf`;
    const withKey = toListingDraftPreview({
      draft: {
        menu: {
          sections: [],
          link: '',
          file: {
            url: menuKey,
            contentType: 'application/pdf',
            fileName: 'm.pdf',
          },
        },
      },
    });
    expect(withKey.menu).toEqual({
      sections: [],
      link: '',
      currency: 'EUR',
      file: {
        url: `${FILES_BASE}/${menuKey}`,
        contentType: 'application/pdf',
        fileName: 'm.pdf',
      },
    });
    const withExtra = toListingDraftPreview({
      draft: { menu: { sections: [], link: 'l', note: 'hidden', file: null } },
    });
    expect(withExtra.menu).toEqual({
      sections: [],
      link: 'l',
      currency: 'EUR',
      file: null,
    });
    const withCurrency = toListingDraftPreview({
      draft: { menu: { sections: [], link: '', currency: 'GBP', file: null } },
    });
    expect((withCurrency.menu as { currency: unknown }).currency).toBe('GBP');
    const junk = toListingDraftPreview({
      draft: { menu: { sections: [], link: '', file: { url: 'junk' } } },
    });
    expect((junk.menu as { file: unknown }).file).toBeNull();
  });

  it('passes menu sections with sub-sections and glass and bottle prices through untouched', () => {
    const sections = [
      {
        title: 'Wines',
        items: [],
        subsections: [
          {
            title: 'Red',
            items: [
              {
                name: 'Douro',
                price: '',
                priceGlass: '5.50',
                priceBottle: '24.00',
                description: '',
                dietary: ['vegan'],
              },
            ],
          },
        ],
      },
      { title: 'Coffee', items: [] },
    ];
    const preview = toListingDraftPreview({
      draft: { menu: { sections, link: '', file: null } },
    });
    expect((preview.menu as { sections: unknown }).sections).toEqual(sections);
  });

  it('nulls photos, coverPhoto, shopItems and menu in an unexpected shape', () => {
    const preview = toListingDraftPreview({
      draft: {
        photos: WIDE_KEY,
        coverPhoto: COVER_KEY,
        shopItems: { image: MUG_KEY },
        menu: MUG_KEY,
      },
    });
    expect(preview).toEqual({
      photos: null,
      coverPhoto: null,
      shopItems: null,
      menu: null,
    });
  });

  it('filters non-object shop entries and resolves or nulls each photo', () => {
    const preview = toListingDraftPreview({
      draft: {
        shopItems: [
          'raw',
          { id: 'a', name: 'A', price: '1', link: '', photo: null },
          { id: 'b', name: 'B', price: '2', link: '', photo: MUG_KEY },
          {
            id: 'c',
            name: 'C',
            price: '3',
            link: '',
            secret: 'x',
            photo: { image: MUG_KEY, alt: 'mug', caption: 'cap', extra: 1 },
          },
        ],
      },
    });
    expect(preview.shopItems).toEqual([
      { id: 'a', name: 'A', price: '1', link: '', photo: null },
      { id: 'b', name: 'B', price: '2', link: '', photo: null },
      {
        id: 'c',
        name: 'C',
        price: '3',
        link: '',
        photo: {
          image: `${FILES_BASE}/${MUG_KEY}`,
          alt: 'mug',
          caption: 'cap',
        },
      },
    ]);
  });

  it('limits photos to the four slots and coverPhoto to image and alt', () => {
    const preview = toListingDraftPreview({
      draft: {
        photos: { wide: WIDE_KEY, hidden: WIDE_KEY },
        coverPhoto: { image: COVER_KEY, alt: 'a', extra: 'x' },
      },
    });
    expect(preview.photos).toEqual({ wide: `${FILES_BASE}/${WIDE_KEY}` });
    expect(preview.coverPhoto).toEqual({
      image: `${FILES_BASE}/${COVER_KEY}`,
      alt: 'a',
    });
  });

  describe('location and hours keys', () => {
    const location = {
      address: 'Rua 1',
      latitude: 1,
      longitude: 2,
      hood: 'Alfama',
      geocoded: true,
    };
    const hours = { hours: {}, hoursNote: 'n', hoursExceptions: [] };

    it('drops location and hours for an online draft', () => {
      const preview = toListingDraftPreview({
        draft: { name: 'N', online: true, ...location, ...hours },
      });
      expect(preview).toEqual({ name: 'N', online: true });
    });

    it('drops location for a mobile draft without a meeting point', () => {
      const preview = toListingDraftPreview({
        draft: { mobile: true, ...location, ...hours },
      });
      expect(preview).toEqual({ mobile: true, ...hours });
    });

    it('keeps location for a mobile draft with a meeting point', () => {
      const preview = toListingDraftPreview({
        draft: { mobile: true, hasMeetingPoint: true, ...location },
      });
      expect(preview).toEqual({ mobile: true, ...location });
    });

    it('drops hours for a by-appointment mobile draft', () => {
      const preview = toListingDraftPreview({
        draft: {
          mobile: true,
          mobileDetails: { byAppointment: true },
          ...hours,
        },
      });
      expect(preview).not.toHaveProperty('hours');
      expect(preview).not.toHaveProperty('hoursNote');
      expect(preview).not.toHaveProperty('hoursExceptions');
    });
  });

  it('reads a payload without an envelope as an empty preview', () => {
    expect(toListingDraftPreview({ step: 2, baseline: 'x' })).toEqual({});
  });
});

describe('toCommunityDraftPreview', () => {
  it('drops stewards, invites, consent, the welcome message, roster visibility and the step', () => {
    const preview = toCommunityDraftPreview({
      step: 4,
      draft: {
        name: 'Trans Hikers',
        purpose: 'Walks',
        stewards: [{ slug: 'ana' }],
        invites: ['rui'],
        consent: true,
        welcomeMessage: 'Hi',
        rosterVisible: false,
        coverImageUrl: COMMUNITY_COVER_KEY,
        avatarImageUrl: '',
      },
    });
    expect(preview).toEqual({
      name: 'Trans Hikers',
      purpose: 'Walks',
      coverImageUrl: `${FILES_BASE}/${COMMUNITY_COVER_KEY}`,
      avatarImageUrl: null,
    });
  });
});
