import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { ListingDraft } from '../listing-drafts/entities/listing-draft.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from '../studio/entities/studio-release.entity';
import { StudioTrack } from '../studio/entities/studio-track.entity';
import { StudioCatalogService } from '../studio/studio-catalog.service';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SubprofilePublicReadService } from '../subprofiles/subprofile-public-read.service';
import { Profile } from '../users/entities/profile.entity';
import { AdminCreatorDraftRowsService } from './admin-creator-draft-rows.service';
import type { CreatorDraftUnionRow } from './admin-creator-draft-union';
import { CreatorDraftMadeForService } from './creator-draft-made-for.service';
import type { AdminCreatorDraftRow } from './creator-draft.types';
import type { CreatorDraftKind } from './creator-drafts.constants';
import { CreatorDraft } from './entities/creator-draft.entity';

const COMMUNITY_DRAFT_ID = '10000000-0000-4000-8000-000000000001';
const PERSONA_ID = '10000000-0000-4000-8000-000000000002';
const LISTING_DRAFT_ID = '10000000-0000-4000-8000-000000000003';
const RELEASE_ID = '10000000-0000-4000-8000-000000000004';
const OTHER_RELEASE_ID = '10000000-0000-4000-8000-000000000005';
const SHOW_RELEASE_ID = '10000000-0000-4000-8000-000000000006';
const EPISODE_ID = '10000000-0000-4000-8000-000000000007';
const EVENT_DRAFT_ID = '10000000-0000-4000-8000-000000000008';
const OTHER_EVENT_DRAFT_ID = '10000000-0000-4000-8000-000000000009';
const LISTING_EDIT_DRAFT_ID = '10000000-0000-4000-8000-00000000000a';
const LISTING_ID = '10000000-0000-4000-8000-00000000000b';
const PRIVATE_PERSONA_ID = '10000000-0000-4000-8000-00000000000c';
const SAVED_AT = new Date('2026-10-18T09:30:00.000Z');
const SAVED_AT_ISO = SAVED_AT.toISOString();

function unionRow(
  kind: CreatorDraftKind,
  id: string,
  ownerUserId: string,
): CreatorDraftUnionRow {
  return { kind, id, owner_user_id: ownerUserId, last_saved_at: SAVED_AT };
}

function wireRow(
  kind: CreatorDraftKind,
  id: string,
  overrides: Partial<AdminCreatorDraftRow> = {},
): AdminCreatorDraftRow {
  return {
    kind,
    id,
    title: null,
    madeFor: null,
    owner: null,
    lastSavedAt: SAVED_AT_ISO,
    progress: null,
    missing: null,
    ...overrides,
  };
}

/** The one row a single-row page answers; any other count fails the test. */
function onlyRow(rows: readonly AdminCreatorDraftRow[]): AdminCreatorDraftRow {
  if (rows.length !== 1) {
    throw new Error(`Expected one row, got ${rows.length}`);
  }
  return rowAt(rows, 0);
}

/** The row at `index`; a missing row fails the test. */
function rowAt(
  rows: readonly AdminCreatorDraftRow[],
  index: number,
): AdminCreatorDraftRow {
  const row = rows[index];
  if (!row) throw new Error(`Expected a row at index ${index}`);
  return row;
}

function storedDraft(overrides: Partial<CreatorDraft>): Partial<CreatorDraft> {
  return {
    userId: 'author-1',
    payloadVersion: 1,
    revision: 3,
    madeForCommunityId: null,
    madeForListingId: null,
    progressDone: null,
    progressTotal: null,
    missing: null,
    updatedAt: SAVED_AT,
    ...overrides,
  };
}

function persona(overrides: Partial<Subprofile> = {}): Partial<Subprofile> {
  return {
    id: PERSONA_ID,
    userId: 'author-2',
    displayName: 'Night Shift',
    handle: 'night-shift',
    status: SubprofileStatus.Draft,
    visibility: SubprofileVisibility.Open,
    removedAt: null,
    ...overrides,
  };
}

function release(
  overrides: Partial<StudioRelease> = {},
): Partial<StudioRelease> {
  return {
    id: RELEASE_ID,
    title: 'Night songs',
    type: StudioReleaseType.Album,
    status: StudioReleaseStatus.Draft,
    coverKey: null,
    rightsConfirmedAt: null,
    subprofile: persona() as Subprofile,
    ...overrides,
  };
}

const LISTING = {
  id: LISTING_ID,
  ref: 'QPL-2026-0001',
  slug: 'cafe-arco',
  name: 'Café Arco',
  status: ListingStatus.Live,
};

const PROFILES = [
  {
    userId: 'author-1',
    slug: 'ana-silva',
    firstName: 'Ana',
    lastName: 'Silva',
    pronouns: 'she/her',
    avatarUrl: null,
    photoVisible: true,
  },
  {
    userId: 'author-2',
    slug: 'rui-costa',
    firstName: 'Rui',
    lastName: 'Costa',
    pronouns: null,
    avatarUrl: null,
    photoVisible: true,
  },
];

describe('AdminCreatorDraftRowsService', () => {
  let service: AdminCreatorDraftRowsService;
  const creatorDrafts = { find: jest.fn() };
  const listingDrafts = { find: jest.fn() };
  const subprofiles = { find: jest.fn() };
  const releases = { find: jest.fn() };
  const tracks = { find: jest.fn() };
  const communities = { find: jest.fn() };
  const listings = { find: jest.fn() };
  const profiles = { find: jest.fn() };
  const publicReads = {
    getDraftPreviewForStaff: jest.fn(),
    draftPublishGapsForStaff: jest.fn(),
  };
  const catalog = { getReleaseAsStaffDraftPreview: jest.fn() };
  const madeFor = { resolveEventRefs: jest.fn() };

  /** Stored rows for every kind; each find answers the rows of the kind it asks for. */
  function givenStoredDrafts(rows: Partial<CreatorDraft>[]): void {
    creatorDrafts.find.mockImplementation(
      ({ where }: { where: { kind: string } }) =>
        Promise.resolve(rows.filter((row) => row.kind === where.kind)),
    );
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    for (const repository of [
      creatorDrafts,
      listingDrafts,
      subprofiles,
      releases,
      tracks,
      communities,
      listings,
    ]) {
      repository.find.mockResolvedValue([]);
    }
    profiles.find.mockResolvedValue(PROFILES);
    publicReads.draftPublishGapsForStaff.mockResolvedValue(new Map());
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminCreatorDraftRowsService,
        { provide: getRepositoryToken(CreatorDraft), useValue: creatorDrafts },
        { provide: getRepositoryToken(ListingDraft), useValue: listingDrafts },
        { provide: getRepositoryToken(Subprofile), useValue: subprofiles },
        { provide: getRepositoryToken(StudioRelease), useValue: releases },
        { provide: getRepositoryToken(StudioTrack), useValue: tracks },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: SubprofilePublicReadService, useValue: publicReads },
        { provide: StudioCatalogService, useValue: catalog },
        { provide: CreatorDraftMadeForService, useValue: madeFor },
      ],
    }).compile();
    service = moduleRef.get(AdminCreatorDraftRowsService);
  });

  it('keeps the page order and resolves every owner in one lookup', async () => {
    givenStoredDrafts([
      storedDraft({
        id: COMMUNITY_DRAFT_ID,
        kind: 'community',
        payload: { draft: { name: 'Lisbon Readers' }, step: 2 },
        progressDone: 2,
        progressTotal: 5,
        missing: ['rules'],
      }),
    ]);
    subprofiles.find.mockResolvedValue([persona()]);
    listingDrafts.find.mockResolvedValue([
      {
        id: LISTING_DRAFT_ID,
        userId: 'author-1',
        payload: { step: 3, draft: { name: 'Café Arco' } },
        updatedAt: SAVED_AT,
      },
    ]);
    const rows = await service.rowsFor([
      unionRow('community', COMMUNITY_DRAFT_ID, 'author-1'),
      unionRow('persona', PERSONA_ID, 'author-2'),
      unionRow('listing', LISTING_DRAFT_ID, 'author-1'),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      'community',
      'persona',
      'listing',
    ]);
    expect(profiles.find).toHaveBeenCalledTimes(1);
    expect(rowAt(rows, 0).owner).toEqual(
      expect.objectContaining({ userId: 'author-1', slug: 'ana-silva' }),
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({
        title: 'Lisbon Readers',
        madeFor: null,
        progress: { done: 2, total: 5 },
        missing: ['rules'],
        lastSavedAt: SAVED_AT_ISO,
      }),
    );
    expect(rowAt(rows, 1).owner).toEqual(
      expect.objectContaining({ userId: 'author-2', slug: 'rui-costa' }),
    );
  });

  it('reads Untitled as null and clamps the wizard step', async () => {
    listingDrafts.find.mockResolvedValue([
      {
        id: LISTING_DRAFT_ID,
        userId: 'author-1',
        payload: { step: 9, draft: { name: '   ' } },
        updatedAt: SAVED_AT,
      },
    ]);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('listing', LISTING_DRAFT_ID, 'author-1'),
      ]),
    );
    expect(row).toEqual(
      expect.objectContaining({
        title: null,
        madeFor: null,
        progress: { done: 6, total: 6 },
        missing: null,
      }),
    );
  });

  it('reads a missing or non-integer wizard step as zero', async () => {
    listingDrafts.find.mockResolvedValue([
      {
        id: LISTING_DRAFT_ID,
        userId: 'author-1',
        payload: { step: 2.5, draft: { name: 'Café Arco' } },
        updatedAt: SAVED_AT,
      },
    ]);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('listing', LISTING_DRAFT_ID, 'author-1'),
      ]),
    );
    expect(row.progress).toEqual({ done: 0, total: 6 });
  });

  it('gives no owner to an author with no profile', async () => {
    profiles.find.mockResolvedValue([]);
    listingDrafts.find.mockResolvedValue([
      {
        id: LISTING_DRAFT_ID,
        userId: 'author-3',
        payload: { step: 1, draft: {} },
        updatedAt: SAVED_AT,
      },
    ]);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('listing', LISTING_DRAFT_ID, 'author-3'),
      ]),
    );
    expect(row.owner).toBeNull();
  });

  it('names the community an event is for, else its listing', async () => {
    givenStoredDrafts([
      storedDraft({
        id: EVENT_DRAFT_ID,
        kind: 'event',
        payload: { title: ' Book swap ' },
        madeForCommunityId: 'community-1',
        progressDone: 3,
        progressTotal: 5,
        missing: ['access', 'care'],
      }),
      storedDraft({
        id: OTHER_EVENT_DRAFT_ID,
        kind: 'event',
        payload: { title: 'Open mic' },
        madeForListingId: LISTING_ID,
      }),
    ]);
    communities.find.mockResolvedValue([
      { id: 'community-1', slug: 'lisbon-readers', name: 'Lisbon Readers' },
    ]);
    listings.find.mockResolvedValue([LISTING]);
    const rows = await service.rowsFor([
      unionRow('event', EVENT_DRAFT_ID, 'author-1'),
      unionRow('event', OTHER_EVENT_DRAFT_ID, 'author-1'),
    ]);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        title: 'Book swap',
        madeFor: {
          kind: 'community',
          name: 'Lisbon Readers',
          slug: 'lisbon-readers',
        },
        progress: { done: 3, total: 5 },
        missing: ['access', 'care'],
      }),
    );
    expect(rows[1]).toEqual(
      expect.objectContaining({
        title: 'Open mic',
        madeFor: { kind: 'listing', name: 'Café Arco', slug: 'cafe-arco' },
        progress: null,
        missing: null,
      }),
    );
    expect(creatorDrafts.find).toHaveBeenCalledTimes(1);
    expect(communities.find).toHaveBeenCalledTimes(1);
    expect(listings.find).toHaveBeenCalledTimes(1);
  });

  it('names a studio release by its persona, slug only when the persona is published', async () => {
    releases.find.mockResolvedValue([
      release(),
      release({
        id: OTHER_RELEASE_ID,
        title: 'Second set',
        status: StudioReleaseStatus.Scheduled,
        subprofile: persona({
          status: SubprofileStatus.Published,
          handle: 'dj-maré',
        }) as Subprofile,
      }),
    ]);
    const rows = await service.rowsFor([
      unionRow('studio_release', RELEASE_ID, 'author-2'),
      unionRow('studio_release', OTHER_RELEASE_ID, 'author-2'),
    ]);
    expect(rows.map((row) => row.madeFor)).toEqual([
      { kind: 'persona', name: 'Night Shift', slug: null },
      { kind: 'persona', name: 'Night Shift', slug: 'dj-maré' },
    ]);
    expect(rows.map((row) => row.title)).toEqual(['Night songs', 'Second set']);
  });

  it('lists what blocks a release from publishing from one batched track read', async () => {
    releases.find.mockResolvedValue([release()]);
    tracks.find.mockResolvedValue([
      {
        id: 'track-1',
        releaseId: RELEASE_ID,
        audioKey: 'studio/audio/track-1.mp3',
        durationSeconds: 214,
        sources: [],
      },
    ]);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('studio_release', RELEASE_ID, 'author-1'),
      ]),
    );
    expect(row.missing).toEqual([
      'studio_publish_missing_cover',
      'studio_publish_missing_rights',
    ]);
    expect(row.progress).toBeNull();
    expect(tracks.find).toHaveBeenCalledTimes(1);
  });

  it('checks publish gaps once for the in-scope personas only', async () => {
    const draftPersona = persona();
    subprofiles.find.mockResolvedValue([
      draftPersona,
      persona({
        id: PRIVATE_PERSONA_ID,
        visibility: SubprofileVisibility.Private,
      }),
    ]);
    publicReads.draftPublishGapsForStaff.mockResolvedValue(
      new Map([[PERSONA_ID, ['avatar_missing']]]),
    );
    const rows = await service.rowsFor([
      unionRow('persona', PERSONA_ID, 'author-2'),
      unionRow('persona', PRIVATE_PERSONA_ID, 'author-2'),
    ]);
    expect(publicReads.draftPublishGapsForStaff).toHaveBeenCalledTimes(1);
    expect(publicReads.draftPublishGapsForStaff).toHaveBeenCalledWith([
      draftPersona,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        title: 'Night Shift',
        madeFor: { kind: 'persona', name: 'Night Shift', slug: null },
        progress: null,
        missing: ['avatar_missing'],
      }),
    );
  });

  it('leaves out a union row whose record vanished between reads', async () => {
    subprofiles.find.mockResolvedValue([]);
    await expect(
      service.rowsFor([unionRow('persona', PERSONA_ID, 'author-2')]),
    ).resolves.toEqual([]);
  });

  it('builds a listing_edit preview from the draft half and never the baseline', async () => {
    givenStoredDrafts([
      storedDraft({
        id: LISTING_EDIT_DRAFT_ID,
        kind: 'listing_edit',
        slotKey: LISTING_ID,
        madeForListingId: LISTING_ID,
        payload: {
          draft: {
            name: 'Café Arco',
            blurb: 'Coffee and zines',
            ownerBio: 'I run the place with my partner',
          },
          baseline: 'fingerprint-1',
        },
      }),
    ]);
    listings.find.mockResolvedValue([LISTING]);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('listing_edit', LISTING_EDIT_DRAFT_ID, 'author-1'),
      ]),
    );
    const detail = await service.detailFor(row);
    expect(detail).toEqual(
      expect.objectContaining({
        kind: 'listing_edit',
        listing: { ref: 'QPL-2026-0001', slug: 'cafe-arco', name: 'Café Arco' },
        preview: { name: 'Café Arco', blurb: 'Coffee and zines' },
      }),
    );
    expect(JSON.stringify(detail)).not.toContain('baseline');
    expect(JSON.stringify(detail)).not.toContain('fingerprint-1');
    expect(JSON.stringify(detail)).not.toContain('ownerBio');
  });

  it('builds an event preview with the community and run-by refs the author holds today', async () => {
    const payload = {
      title: 'Book swap',
      communitySlug: 'lisbon-readers',
      address: 'Rua das Flores 12',
      runByListingId: LISTING_ID,
    };
    givenStoredDrafts([
      storedDraft({
        id: EVENT_DRAFT_ID,
        kind: 'event',
        userId: 'author-1',
        payload,
        madeForCommunityId: 'community-1',
      }),
    ]);
    madeFor.resolveEventRefs.mockResolvedValue({
      community: {
        id: 'community-1',
        slug: 'lisbon-readers',
        name: 'Lisbon Readers',
      },
      runByListing: null,
      venueListing: null,
      madeForCommunityId: 'community-1',
      madeForListingId: null,
    });
    communities.find.mockResolvedValue([
      {
        id: 'community-1',
        slug: 'lisbon-readers',
        name: 'Lisbon Readers',
        archivedAt: null,
      },
    ]);
    const row = onlyRow(
      await service.rowsFor([unionRow('event', EVENT_DRAFT_ID, 'author-1')]),
    );
    const detail = await service.detailFor(row);
    expect(madeFor.resolveEventRefs).toHaveBeenCalledWith('author-1', payload);
    expect(detail?.preview).toEqual(
      expect.objectContaining({
        community: { slug: 'lisbon-readers', name: 'Lisbon Readers' },
        runByListing: null,
      }),
    );
    expect(detail?.preview).not.toHaveProperty('address');
    expect(detail?.preview).not.toHaveProperty('runByListingId');
  });

  it('hands the episode preview the show release and the episode id', async () => {
    tracks.find.mockResolvedValue([
      {
        id: EPISODE_ID,
        releaseId: SHOW_RELEASE_ID,
        title: 'Episode four',
        release: release({
          id: SHOW_RELEASE_ID,
          type: StudioReleaseType.Podcast,
          status: StudioReleaseStatus.Published,
          subprofile: persona({
            status: SubprofileStatus.Published,
          }) as Subprofile,
        }),
      },
    ]);
    const preview = {
      id: SHOW_RELEASE_ID,
      tracks: [{ id: EPISODE_ID, isDraft: true }],
    };
    catalog.getReleaseAsStaffDraftPreview.mockResolvedValue(preview);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('studio_episode', EPISODE_ID, 'author-2'),
      ]),
    );
    expect(row).toEqual(
      expect.objectContaining({
        title: 'Episode four',
        madeFor: { kind: 'persona', name: 'Night Shift', slug: 'night-shift' },
        progress: null,
        missing: null,
      }),
    );
    const detail = await service.detailFor(row);
    expect(catalog.getReleaseAsStaffDraftPreview).toHaveBeenCalledWith(
      SHOW_RELEASE_ID,
      EPISODE_ID,
    );
    expect(detail).toEqual(
      expect.objectContaining({
        kind: 'studio_episode',
        episodeTrackId: EPISODE_ID,
        preview,
      }),
    );
    expect(tracks.find).toHaveBeenCalledTimes(1);
  });

  it('answers null when the show or the episode went before the preview', async () => {
    tracks.find.mockResolvedValue([
      {
        id: EPISODE_ID,
        releaseId: SHOW_RELEASE_ID,
        title: 'Episode four',
        release: release({ id: SHOW_RELEASE_ID }),
      },
    ]);
    catalog.getReleaseAsStaffDraftPreview.mockRejectedValue(
      new NotFoundException('Episode not found'),
    );
    const row = onlyRow(
      await service.rowsFor([
        unionRow('studio_episode', EPISODE_ID, 'author-2'),
      ]),
    );
    await expect(service.detailFor(row)).resolves.toBeNull();
  });

  it('answers null when the release went before the preview', async () => {
    releases.find.mockResolvedValue([release()]);
    catalog.getReleaseAsStaffDraftPreview.mockRejectedValue(
      new NotFoundException('Release not found'),
    );
    const row = onlyRow(
      await service.rowsFor([
        unionRow('studio_release', RELEASE_ID, 'author-2'),
      ]),
    );
    await expect(service.detailFor(row)).resolves.toBeNull();
    expect(catalog.getReleaseAsStaffDraftPreview).toHaveBeenCalledWith(
      RELEASE_ID,
    );
  });

  it('gives a listing edit on a listing that is not live a null slug', async () => {
    givenStoredDrafts([
      storedDraft({
        id: LISTING_EDIT_DRAFT_ID,
        kind: 'listing_edit',
        slotKey: LISTING_ID,
        madeForListingId: LISTING_ID,
        payload: { draft: { name: '' }, baseline: 'fingerprint-1' },
      }),
    ]);
    listings.find.mockResolvedValue([
      { ...LISTING, status: ListingStatus.Review },
    ]);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('listing_edit', LISTING_EDIT_DRAFT_ID, 'author-1'),
      ]),
    );
    expect(row.title).toBe('Café Arco');
    expect(row.madeFor).toEqual({
      kind: 'listing',
      name: 'Café Arco',
      slug: null,
    });
    const detail = await service.detailFor(row);
    expect(detail).toEqual(
      expect.objectContaining({
        listing: { ref: 'QPL-2026-0001', slug: null, name: 'Café Arco' },
      }),
    );
  });

  it('leaves out a listing edit whose listing went', async () => {
    givenStoredDrafts([
      storedDraft({
        id: LISTING_EDIT_DRAFT_ID,
        kind: 'listing_edit',
        madeForListingId: LISTING_ID,
        payload: { draft: { name: 'Café Arco' } },
      }),
    ]);
    await expect(
      service.rowsFor([
        unionRow('listing_edit', LISTING_EDIT_DRAFT_ID, 'author-1'),
      ]),
    ).resolves.toEqual([]);
  });

  it('answers null when the persona preview cannot be built', async () => {
    subprofiles.find.mockResolvedValue([persona()]);
    publicReads.getDraftPreviewForStaff.mockResolvedValue(null);
    const row = onlyRow(
      await service.rowsFor([unionRow('persona', PERSONA_ID, 'author-2')]),
    );
    await expect(service.detailFor(row)).resolves.toBeNull();
    expect(publicReads.getDraftPreviewForStaff).toHaveBeenCalledWith(
      PERSONA_ID,
    );
  });

  it('builds a community preview from the allow-list and leaves the people out', async () => {
    givenStoredDrafts([
      storedDraft({
        id: COMMUNITY_DRAFT_ID,
        kind: 'community',
        payload: {
          draft: {
            name: 'Lisbon Readers',
            stewards: ['someone'],
            welcomeMessage: 'Hello there',
          },
          step: 3,
        },
      }),
    ]);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('community', COMMUNITY_DRAFT_ID, 'author-1'),
      ]),
    );
    const detail = await service.detailFor(row);
    expect(detail).toEqual(
      expect.objectContaining({
        kind: 'community',
        preview: { name: 'Lisbon Readers' },
      }),
    );
  });

  it('answers null for a row this service did not build, with no read', async () => {
    givenStoredDrafts([
      storedDraft({
        id: COMMUNITY_DRAFT_ID,
        kind: 'community',
        payload: { draft: { name: 'Lisbon Readers' }, step: 3 },
      }),
    ]);
    await expect(
      service.detailFor(wireRow('community', COMMUNITY_DRAFT_ID)),
    ).resolves.toBeNull();
    expect(creatorDrafts.find).not.toHaveBeenCalled();
  });

  it('gives an event made for an archived community a null slug', async () => {
    givenStoredDrafts([
      storedDraft({
        id: EVENT_DRAFT_ID,
        kind: 'event',
        payload: { title: 'Book swap' },
        madeForCommunityId: 'community-1',
      }),
    ]);
    communities.find.mockResolvedValue([
      {
        id: 'community-1',
        slug: 'lisbon-readers',
        name: 'Lisbon Readers',
        archivedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ]);
    const row = onlyRow(
      await service.rowsFor([unionRow('event', EVENT_DRAFT_ID, 'author-1')]),
    );
    expect(row.madeFor).toEqual({
      kind: 'community',
      name: 'Lisbon Readers',
      slug: null,
    });
  });

  it('gives the run-by listing of an event preview a null slug when it is not live', async () => {
    const payload = { title: 'Open mic', runByListingId: LISTING_ID };
    givenStoredDrafts([
      storedDraft({
        id: EVENT_DRAFT_ID,
        kind: 'event',
        payload,
        madeForListingId: LISTING_ID,
      }),
    ]);
    listings.find.mockResolvedValue([
      { ...LISTING, status: ListingStatus.Review },
    ]);
    madeFor.resolveEventRefs.mockResolvedValue({
      community: null,
      runByListing: { id: LISTING_ID, slug: 'cafe-arco', name: 'Café Arco' },
      venueListing: null,
      madeForCommunityId: null,
      madeForListingId: LISTING_ID,
    });
    const row = onlyRow(
      await service.rowsFor([unionRow('event', EVENT_DRAFT_ID, 'author-1')]),
    );
    const detail = await service.detailFor(row);
    expect(detail?.preview).toEqual(
      expect.objectContaining({
        community: null,
        runByListing: { slug: null, name: 'Café Arco' },
      }),
    );
  });

  it('previews a legacy flat list-a-business payload', async () => {
    listingDrafts.find.mockResolvedValue([
      {
        id: LISTING_DRAFT_ID,
        userId: 'author-1',
        payload: { step: 2, name: 'Café Arco', ownerBio: 'Ana runs it' },
        updatedAt: SAVED_AT,
      },
    ]);
    const row = onlyRow(
      await service.rowsFor([
        unionRow('listing', LISTING_DRAFT_ID, 'author-1'),
      ]),
    );
    expect(row.title).toBe('Café Arco');
    const detail = await service.detailFor(row);
    expect(detail).toEqual(
      expect.objectContaining({
        kind: 'listing',
        preview: { name: 'Café Arco' },
      }),
    );
  });
});
