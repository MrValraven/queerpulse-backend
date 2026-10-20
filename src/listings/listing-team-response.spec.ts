import type { CropRect } from '../media-crops/crop-rect';
import { toBareKey } from '../storage/bare-key';
import {
  SubprofileKind,
  SubprofileLinkVisibility,
} from '../subprofiles/entities/subprofile.entity';
import {
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './entities/listing-team-member.entity';
import type { Listing } from './entities/listing.entity';
import { toDirectoryCard } from './listing-response';
import {
  LISTING_TEAM_LISTING_COLUMNS,
  ownerNameOf,
  personaAvatarKeys,
  teamStatusOf,
  toListingTeamListing,
  toListingTeamManagerRow,
  toListingTeamPersona,
  toListingTeamPersonaRow,
  toListingWorksAt,
  type ListingTeamPersonaColumns,
} from './listing-team-response';

const AVATAR_KEY = 'uploads/persona-avatar.jpg';
const CROP: CropRect = {
  x: 0.1,
  y: 0.2,
  width: 0.5,
  height: 0.5,
  aspect: '1:1',
};

function makePersona(
  overrides: Partial<ListingTeamPersonaColumns> = {},
): ListingTeamPersonaColumns {
  return {
    id: 'persona-1',
    handle: 'ink-ana',
    displayName: 'Ink Ana',
    kind: SubprofileKind.Photographer,
    avatarUrl: AVATAR_KEY,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    ...overrides,
  };
}

function makeListing(): Listing {
  return {
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'casa-t',
    name: 'Casa T',
    ownerId: 'owner-uuid',
    cats: ['space'],
    hood: 'Anjos',
    city: 'Lisbon',
    timezone: 'Europe/Lisbon',
    blurb: 'A community house.',
    tagline: '',
    tags: [],
    price: '',
    badge: '',
    photoGallery: [],
    alt: { wide: '', d1: '', d2: '', vibe: '' },
    photos: { wide: '', d1: '', d2: '', vibe: '' },
    hours: {},
    hoursExceptions: [],
    hoursNote: '',
    langs: [],
    whatItIs: [],
    goodFor: [],
    services: [],
    menu: { sections: [], file: null, link: '' },
    pricingMode: 'services',
    accessibilityAnswers: {},
    accessibilityNote: '',
    social: {},
    address: 'R. dos Anjos 1',
    online: false,
    latitude: null,
    longitude: null,
    ownerName: 'Ana Silva',
    ownerRole: '',
    ownerBio: '',
    memberFirst: 'Ana',
    visibility: 'anon',
    linkToProfile: false,
    movedToListingId: null,
    safeSpaceStatus: 'none',
    safeSpaceTier: null,
    safeSpaceVerifier: '',
    safeSpaceReVerifiedAt: null,
    safeSpaceSub: '',
    safeSpacePromises: [],
    safeSpaceVouches: [],
    safeSpaceRemoval: null,
  } as unknown as Listing;
}

function makeMember(
  overrides: Partial<ListingTeamMember> = {},
): ListingTeamMember {
  return {
    id: 'member-1',
    listingId: 'listing-1',
    subprofileId: 'persona-1',
    roleLabel: 'Resident artist',
    status: ListingTeamMemberStatus.Accepted,
    initiatedBy: ListingTeamInitiator.Listing,
    requestedByUserId: 'member-uuid',
    requestedBy: { id: 'member-uuid' },
    answeredAt: new Date('2026-10-19T10:00:00.000Z'),
    position: 2,
    createdAt: new Date('2026-10-18T09:00:00.000Z'),
    updatedAt: new Date('2026-10-19T10:00:00.000Z'),
    ...overrides,
  } as unknown as ListingTeamMember;
}

describe('listing team response mappers', () => {
  it('carries the avatar like the public view and omits the crop key when none was saved', () => {
    const crops = new Map<string, CropRect>([[toBareKey(AVATAR_KEY), CROP]]);
    const withCrop = toListingTeamPersona(makePersona(), crops, null);
    expect(withCrop?.avatarCrop).toEqual(CROP);

    const withoutCrop = toListingTeamPersona(makePersona(), new Map(), null);
    expect(withoutCrop).not.toBeNull();
    expect('avatarCrop' in (withoutCrop as object)).toBe(false);
  });

  it('refuses a persona with no handle', () => {
    expect(
      toListingTeamPersona(makePersona({ handle: null }), new Map(), null),
    ).toBeNull();
  });

  it('carries the owner name for a linked persona and null for an unlinked one even when a name is passed', () => {
    const linked = toListingTeamPersona(
      makePersona({ linkVisibility: SubprofileLinkVisibility.Linked }),
      new Map(),
      'Ana Silva',
    );
    expect(linked?.ownerName).toBe('Ana Silva');

    const unlinked = toListingTeamPersona(
      makePersona({ linkVisibility: SubprofileLinkVisibility.Unlinked }),
      new Map(),
      'Ana Silva',
    );
    expect(unlinked).not.toBeNull();
    expect(unlinked?.ownerName).toBeNull();
    expect(JSON.stringify(unlinked)).not.toContain('Ana Silva');

    const linkedWithoutName = toListingTeamPersona(
      makePersona({ linkVisibility: SubprofileLinkVisibility.Linked }),
      new Map(),
      null,
    );
    expect(linkedWithoutName?.ownerName).toBeNull();
  });

  it('composes the owner name like the persona directory and turns blank parts into null', () => {
    expect(ownerNameOf('Ana', 'Silva')).toBe('Ana Silva');
    expect(ownerNameOf('Ana', '')).toBe('Ana');
    expect(ownerNameOf(' ', ' ')).toBeNull();
    expect(ownerNameOf(null, null)).toBeNull();
  });

  it('builds the listing summary from the directory card', () => {
    const listing = makeListing();
    const card = toDirectoryCard(listing, new Map());
    const summary = toListingTeamListing(listing, new Map());
    expect(summary.id).toBe(listing.id);
    expect(summary.slug).toBe(card.slug);
    expect(summary.name).toBe(card.name);
    expect(summary.cat).toBe(card.cat);
    expect(summary.coverPhoto).toEqual(card.coverPhoto);
    expect(summary.tint).toBe(card.tint);
    expect(summary.av).toBe(card.av);
  });

  it('selects exactly the columns the listing summary reads', () => {
    expect(Object.keys(LISTING_TEAM_LISTING_COLUMNS).sort()).toEqual([
      'cats',
      'coverPhoto',
      'id',
      'name',
      'photoGallery',
      'slug',
    ]);
  });

  it('gives a pending row a null position and an accepted row its position', () => {
    const persona = toListingTeamPersona(makePersona(), new Map(), null);
    const pending = toListingTeamManagerRow(
      makeMember({
        status: ListingTeamMemberStatus.Pending,
        answeredAt: null,
        position: 4,
      }),
      persona,
    );
    expect(pending.position).toBeNull();
    expect(pending.status).toBe('pending');
    expect(pending.answeredAt).toBeNull();
    expect(pending.createdAt).toBe('2026-10-18T09:00:00.000Z');

    const accepted = toListingTeamManagerRow(makeMember(), persona);
    expect(accepted.position).toBe(2);
    expect(accepted.status).toBe('accepted');
    expect(accepted.answeredAt).toBe('2026-10-19T10:00:00.000Z');
  });

  it('keeps every user id off every shape it builds and the member name off an unlinked persona', () => {
    const listing = makeListing();
    const member = makeMember();
    const persona = toListingTeamPersona(makePersona(), new Map(), 'Ana Silva');
    const summary = toListingTeamListing(listing, new Map());
    const shapes = [
      persona,
      summary,
      toListingTeamManagerRow(member, persona),
      toListingTeamPersonaRow(member, summary, true),
      toListingWorksAt(summary, member.roleLabel),
      { persona, teamStatus: teamStatusOf(member.status) },
      { listing: summary, teamStatus: teamStatusOf(member.status) },
      { persona, roleLabel: member.roleLabel },
    ];
    const forbidden = [
      'member-uuid',
      'owner-uuid',
      'Ana Silva',
      'userId',
      'ownerId',
      'requestedBy',
      'memberFirst',
      'memberAvatarUrl',
      'ownerSlug',
    ];
    for (const shape of shapes) {
      const serialized = JSON.stringify(shape);
      for (const term of forbidden) {
        expect(serialized).not.toContain(term);
      }
    }
  });

  it('maps ended statuses to no team status', () => {
    expect(teamStatusOf(ListingTeamMemberStatus.Declined)).toBeNull();
    expect(teamStatusOf(ListingTeamMemberStatus.Cancelled)).toBeNull();
    expect(teamStatusOf(ListingTeamMemberStatus.Removed)).toBeNull();
    expect(teamStatusOf(ListingTeamMemberStatus.Left)).toBeNull();
    expect(teamStatusOf(null)).toBeNull();
    expect(teamStatusOf(ListingTeamMemberStatus.Pending)).toBe('pending');
    expect(teamStatusOf(ListingTeamMemberStatus.Accepted)).toBe('accepted');
  });

  it('lists the avatar keys of personas that have one', () => {
    expect(
      personaAvatarKeys([
        makePersona(),
        makePersona({ id: 'persona-2', avatarUrl: null }),
      ]),
    ).toEqual([AVATAR_KEY]);
  });
});
