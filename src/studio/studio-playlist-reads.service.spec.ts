import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { StudioPlaylistTrack } from './entities/studio-playlist-track.entity';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioAccessService } from './studio-access.service';
import { StudioCatalogService } from './studio-catalog.service';
import { encodePlaylistCursor } from './studio-playlist-cursor';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import {
  creditPersonaCreatorIdSql,
  personaCreatorBlockExemptSql,
  personaCreditActiveSql,
  publiclyListedPlaylistSql,
} from './studio-playlist-visibility';
import { StudioReleaseCard } from './studio-response';
import { withdrawnReleaseSql } from './studio-visibility';

const OWNER_ID = 'e1000000-0000-4000-8000-000000000001';
const OWNER_SLUG = 'ana-silva';
const VIEWER_ID = 'e1000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'e2000000-0000-4000-8000-000000000001';
const PERSONA_CREATOR_ID = 'e1000000-0000-4000-8000-000000000003';
const PLAYLIST_ID = 'e3000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'e4000000-0000-4000-8000-000000000001';
const TRACK_A = 'e5000000-0000-4000-8000-00000000000a';
const TRACK_B = 'e5000000-0000-4000-8000-00000000000b';
const TRACK_C = 'e5000000-0000-4000-8000-00000000000c';
const coverKey = (index: number): string =>
  `persona/c0000000-0000-4000-8000-00000000000${index}/c0000000-0000-4000-8000-00000000001${index}.jpg`;

type WhereMock = jest.Mock<
  QueryBuilderMock,
  [predicate: string, parameters?: Record<string, unknown>]
>;

interface QueryBuilderMock {
  innerJoin: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  where: WhereMock;
  andWhere: WhereMock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  groupBy: jest.Mock;
  addGroupBy: jest.Mock;
  getMany: jest.Mock;
  getRawMany: jest.Mock;
}

function queryBuilderMock(
  result: { many?: unknown[]; raw?: unknown[] } = {},
): QueryBuilderMock {
  const queryBuilder = {} as QueryBuilderMock;
  for (const method of [
    'innerJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'groupBy',
    'addGroupBy',
  ] as const) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(result.many ?? []);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(result.raw ?? []);
  return queryBuilder;
}

const predicatesOf = (queryBuilder: QueryBuilderMock): string[] => [
  ...queryBuilder.where.mock.calls.map(([predicate]) => predicate),
  ...queryBuilder.andWhere.mock.calls.map(([predicate]) => predicate),
];

const playlistRow = (
  overrides: Partial<StudioPlaylist> = {},
): StudioPlaylist => ({
  id: PLAYLIST_ID,
  userId: OWNER_ID,
  name: 'Night bus',
  description: null,
  visibility: StudioPlaylistVisibility.Public,
  creditSubprofileId: null,
  isCreditedToPersona: false,
  createdAt: new Date('2026-10-10T09:00:00.000Z'),
  updatedAt: new Date('2026-10-11T09:00:00.000Z'),
  ...overrides,
});

const ownerProfile = {
  userId: OWNER_ID,
  slug: OWNER_SLUG,
  firstName: 'Ana',
  lastName: 'Silva',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};

const trackRow = (id: string, position: number): StudioTrack =>
  ({
    id,
    releaseId: RELEASE_ID,
    position,
    title: `Track ${position}`,
    audioKey: 'studio-audio/a/b.mp3',
    audioContentType: 'audio/mpeg',
    durationSeconds: 200,
    isExplicit: false,
  }) as StudioTrack;

const entryRow = (
  id: string,
  trackId: string | null,
  position: number,
): StudioPlaylistTrack => ({
  id,
  playlistId: PLAYLIST_ID,
  trackId,
  position,
  addedAt: new Date(`2026-10-1${position}T09:00:00.000Z`),
});

const releaseCard = {
  id: RELEASE_ID,
  title: 'Lisbon at four',
} as StudioReleaseCard;

describe('StudioPlaylistReadsService', () => {
  let playlists: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let entries: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let tracks: { createQueryBuilder: jest.Mock };
  let subprofiles: { find: jest.Mock; findOne: jest.Mock };
  let profiles: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let catalog: { cardsByReleaseId: jest.Mock; getTrack: jest.Mock };
  let access: { hasAccess: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock; isBlockedEitherWay: jest.Mock };
  let connections: { areConnected: jest.Mock };
  let users: { exists: jest.Mock };
  let service: StudioPlaylistReadsService;

  const queueBuilders = (
    repository: { createQueryBuilder: jest.Mock },
    builders: QueryBuilderMock[],
  ): void => {
    repository.createQueryBuilder.mockImplementation(
      () => builders.shift() ?? queryBuilderMock(),
    );
  };

  beforeAll(() => setImageUrlBase('https://api.test'));
  afterAll(() => resetImageUrlBaseForTesting());

  beforeEach(() => {
    playlists = {
      findOne: jest.fn().mockResolvedValue(playlistRow()),
      createQueryBuilder: jest.fn(() => queryBuilderMock()),
    };
    entries = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => queryBuilderMock()),
    };
    tracks = { createQueryBuilder: jest.fn(() => queryBuilderMock()) };
    subprofiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: PERSONA_ID, userId: PERSONA_CREATOR_ID }),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([ownerProfile]),
      // `MemberLookup.userIdsForSlugs`: the slug of an active member.
      createQueryBuilder: jest.fn(() =>
        queryBuilderMock({ many: [ownerProfile] }),
      ),
    };
    catalog = {
      cardsByReleaseId: jest
        .fn()
        .mockResolvedValue(new Map([[RELEASE_ID, releaseCard]])),
      getTrack: jest.fn().mockResolvedValue({ id: TRACK_A }),
    };
    access = { hasAccess: jest.fn().mockResolvedValue(true) };
    blockFilter = {
      excludeBlocked: jest.fn((queryBuilder: QueryBuilderMock) => queryBuilder),
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    };
    connections = { areConnected: jest.fn().mockResolvedValue(false) };
    users = { exists: jest.fn().mockResolvedValue(true) };
    service = new StudioPlaylistReadsService(
      playlists as unknown as Repository<StudioPlaylist>,
      entries as unknown as Repository<StudioPlaylistTrack>,
      tracks as unknown as Repository<StudioTrack>,
      subprofiles as unknown as Repository<Subprofile>,
      profiles as unknown as Repository<Profile>,
      catalog as unknown as StudioCatalogService,
      access as unknown as StudioAccessService,
      blockFilter as unknown as BlockFilterService,
      connections as unknown as ConnectionsService,
      users as unknown as Repository<User>,
    );
  });

  const personaCreatorFilterCall = [
    creditPersonaCreatorIdSql('playlist'),
    {
      unless: personaCreatorBlockExemptSql('playlist', 'blockFilterActorId'),
    },
  ];

  const standingPersonaPlaylist = (): void => {
    playlists.findOne.mockResolvedValue(
      playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      }),
    );
    queueBuilders(playlists, [
      queryBuilderMock({ raw: [{ playlist_id: PLAYLIST_ID }] }),
    ]);
    subprofiles.find.mockResolvedValue([
      {
        id: PERSONA_ID,
        handle: 'night-shift',
        displayName: 'Night Shift',
        kind: 'dj',
        avatarUrl: null,
      },
    ]);
  };

  describe('getPlaylist', () => {
    it('answers 404 for a playlist that does not exist', async () => {
      playlists.findOne.mockResolvedValue(null);
      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for a private playlist to anyone but its owner, before any other lookup', async () => {
      playlists.findOne.mockResolvedValue(
        playlistRow({ visibility: StudioPlaylistVisibility.Private }),
      );
      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(access.hasAccess).not.toHaveBeenCalled();

      const ownerView = await service.getPlaylist(OWNER_ID, PLAYLIST_ID);
      expect(ownerView.visibility).toBe('private');
      expect(ownerView.isOwner).toBe(true);
    });

    it('opens a public playlist to a granted member and asks nothing about connections', async () => {
      const view = await service.getPlaylist(VIEWER_ID, PLAYLIST_ID);
      expect(view.isOwner).toBe(false);
      expect(view.visibility).toBeNull();
      expect(view.creditSubprofileId).toBeNull();
      expect(access.hasAccess).toHaveBeenCalledWith(OWNER_ID);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        VIEWER_ID,
        OWNER_ID,
      );
      expect(connections.areConnected).not.toHaveBeenCalled();
    });

    it('answers 404 for a public playlist when the owner and the viewer are blocked either way', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 while the owner holds no Studio grant', async () => {
      access.hasAccess.mockResolvedValue(false);
      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 to everyone else while the owner account is not active, and still opens it to the owner', async () => {
      users.exists.mockResolvedValue(false);
      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(users.exists).toHaveBeenCalledWith({
        where: { id: OWNER_ID, status: 'active' },
      });

      users.exists.mockClear();
      const ownerView = await service.getPlaylist(OWNER_ID, PLAYLIST_ID);
      expect(ownerView.isOwner).toBe(true);
      expect(users.exists).not.toHaveBeenCalled();
    });

    it('answers 404 for a persona-credited playlist when the viewer and the persona creator are blocked either way', async () => {
      standingPersonaPlaylist();
      blockFilter.isBlockedEitherWay.mockImplementation(
        (_viewerId: string, otherUserId: string) =>
          Promise.resolve(otherUserId === PERSONA_CREATOR_ID),
      );

      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(subprofiles.findOne).toHaveBeenCalledWith({
        where: { id: PERSONA_ID },
        select: { id: true, userId: true },
      });
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        VIEWER_ID,
        PERSONA_CREATOR_ID,
      );
    });

    it('opens a persona-credited playlist when nobody is blocked', async () => {
      standingPersonaPlaylist();
      const view = await service.getPlaylist(VIEWER_ID, PLAYLIST_ID);
      expect(view.credit.persona?.name).toBe('Night Shift');
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        VIEWER_ID,
        PERSONA_CREATOR_ID,
      );
    });

    it('asks nothing about a persona creator for a member-credited playlist', async () => {
      await service.getPlaylist(VIEWER_ID, PLAYLIST_ID);
      expect(subprofiles.findOne).not.toHaveBeenCalled();
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledTimes(1);
    });

    it('opens a connections-only playlist to an accepted connection and 404s it for anyone else', async () => {
      playlists.findOne.mockResolvedValue(
        playlistRow({ visibility: StudioPlaylistVisibility.Connections }),
      );
      connections.areConnected.mockResolvedValueOnce(true);
      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).resolves.toEqual(expect.objectContaining({ id: PLAYLIST_ID }));
      expect(connections.areConnected).toHaveBeenCalledWith(
        VIEWER_ID,
        OWNER_ID,
      );

      connections.areConnected.mockResolvedValueOnce(false);
      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reads a playlist whose persona credit is gone as private: its owner sees their own name, everyone else gets 404', async () => {
      playlists.findOne.mockResolvedValue(
        playlistRow({ creditSubprofileId: null, isCreditedToPersona: true }),
      );
      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      const ownerView = await service.getPlaylist(OWNER_ID, PLAYLIST_ID);
      expect(ownerView.visibility).toBe('private');
      expect(ownerView.credit).toEqual({
        persona: null,
        member: {
          id: OWNER_ID,
          slug: OWNER_SLUG,
          displayName: 'Ana Silva',
          avatarUrl: null,
        },
      });
      expect(ownerView.creditSubprofileId).toBeNull();
    });

    it('reads a credit to a persona that stopped standing as private for its owner', async () => {
      playlists.findOne.mockResolvedValue(
        playlistRow({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
        }),
      );
      const standing = queryBuilderMock({ raw: [] });
      queueBuilders(playlists, [standing]);

      const ownerView = await service.getPlaylist(OWNER_ID, PLAYLIST_ID);

      expect(predicatesOf(standing)).toContain(
        personaCreditActiveSql('playlist'),
      );
      expect(ownerView.visibility).toBe('private');
      expect(ownerView.credit.persona).toBeNull();
      expect(ownerView.creditSubprofileId).toBeNull();
    });

    it('reads a standing credit whose persona did not load as broken: private and unnamed for the owner, 404 for everyone else', async () => {
      playlists.findOne.mockResolvedValue(
        playlistRow({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
        }),
      );
      queueBuilders(playlists, [
        queryBuilderMock({ raw: [{ playlist_id: PLAYLIST_ID }] }),
        queryBuilderMock({ raw: [{ playlist_id: PLAYLIST_ID }] }),
      ]);
      subprofiles.find.mockResolvedValue([]);

      await expect(
        service.getPlaylist(VIEWER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      const ownerView = await service.getPlaylist(OWNER_ID, PLAYLIST_ID);
      expect(ownerView.visibility).toBe('private');
      expect(ownerView.credit.persona).toBeNull();
      expect(ownerView.credit.member?.id).toBe(OWNER_ID);
      expect(ownerView.creditSubprofileId).toBeNull();
    });

    it('never names the owner of a persona-credited playlist', async () => {
      playlists.findOne.mockResolvedValue(
        playlistRow({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
        }),
      );
      queueBuilders(playlists, [
        queryBuilderMock({ raw: [{ playlist_id: PLAYLIST_ID }] }),
      ]);
      subprofiles.find.mockResolvedValue([
        {
          id: PERSONA_ID,
          handle: 'night-shift',
          displayName: 'Night Shift',
          kind: 'dj',
          avatarUrl: null,
        },
      ]);

      const view = await service.getPlaylist(VIEWER_ID, PLAYLIST_ID);

      expect(view.credit.member).toBeNull();
      expect(view.credit.persona?.name).toBe('Night Shift');
      expect(profiles.find).not.toHaveBeenCalled();
      expect(JSON.stringify(view)).not.toContain(OWNER_ID);
    });

    it('shows the owner every entry and marks the unavailable ones', async () => {
      entries.find.mockResolvedValue([
        entryRow('entry-1', TRACK_A, 1),
        entryRow('entry-2', TRACK_B, 2),
        entryRow('entry-3', null, 3),
        entryRow('entry-4', TRACK_C, 4),
      ]);
      queueBuilders(tracks, [
        queryBuilderMock({
          many: [trackRow(TRACK_A, 1), trackRow(TRACK_C, 3)],
        }),
      ]);

      const view = await service.getPlaylist(OWNER_ID, PLAYLIST_ID);

      expect(
        view.entries.map((entry) => [
          entry.entryId,
          entry.position,
          entry.isAvailable,
        ]),
      ).toEqual([
        ['entry-1', 1, true],
        ['entry-2', 2, false],
        ['entry-3', 3, false],
        ['entry-4', 4, true],
      ]);
      expect(view.entries[1]?.track).toBeNull();
      expect(view.entries[0]?.track?.release).toBe(releaseCard);
    });

    it('drops unavailable entries for a viewer and numbers the rest from 1', async () => {
      entries.find.mockResolvedValue([
        entryRow('entry-1', TRACK_A, 1),
        entryRow('entry-2', TRACK_B, 2),
        entryRow('entry-3', null, 3),
        entryRow('entry-4', TRACK_C, 4),
      ]);
      const playable = queryBuilderMock({
        many: [trackRow(TRACK_A, 1), trackRow(TRACK_C, 3)],
      });
      queueBuilders(tracks, [playable]);

      const view = await service.getPlaylist(VIEWER_ID, PLAYLIST_ID);

      expect(
        view.entries.map((entry) => [
          entry.entryId,
          entry.position,
          entry.isAvailable,
        ]),
      ).toEqual([
        ['entry-1', 1, true],
        ['entry-4', 2, true],
      ]);
      expect(playable.where).toHaveBeenCalledWith(
        'track.id IN (:...playableTrackIds)',
        { playableTrackIds: [TRACK_A, TRACK_B, TRACK_C] },
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        playable,
        VIEWER_ID,
        '"persona"."user_id"',
      );
    });

    // Studio open demo pages: the owner reads why a row is unavailable when
    // staff took its release down.
    it('marks an owner entry withdrawn when staff took its release down, and only that one', async () => {
      entries.find.mockResolvedValue([
        entryRow('entry-1', TRACK_A, 1),
        entryRow('entry-2', TRACK_B, 2),
        entryRow('entry-3', null, 3),
        entryRow('entry-4', TRACK_C, 4),
      ]);
      const withdrawn = queryBuilderMock({ raw: [{ track_id: TRACK_B }] });
      queueBuilders(tracks, [
        queryBuilderMock({ many: [trackRow(TRACK_A, 1)] }),
        withdrawn,
      ]);

      const view = await service.getPlaylist(OWNER_ID, PLAYLIST_ID);

      expect(
        view.entries.map((entry) => [
          entry.entryId,
          entry.isAvailable,
          entry.unavailableReason,
        ]),
      ).toEqual([
        ['entry-1', true, undefined],
        ['entry-2', false, 'withdrawn'],
        ['entry-3', false, undefined],
        ['entry-4', false, undefined],
      ]);
      expect(view.entries[2]).not.toHaveProperty('unavailableReason');
      expect(withdrawn.where).toHaveBeenCalledWith(
        'track.id IN (:...withdrawnTrackIds)',
        { withdrawnTrackIds: [TRACK_B, TRACK_C] },
      );
      expect(predicatesOf(withdrawn)).toContain(
        withdrawnReleaseSql('release', 'persona'),
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        withdrawn,
        OWNER_ID,
        '"persona"."user_id"',
      );
    });

    it('asks nothing about withdrawn releases when every owner entry plays', async () => {
      entries.find.mockResolvedValue([entryRow('entry-1', TRACK_A, 1)]);
      queueBuilders(tracks, [
        queryBuilderMock({ many: [trackRow(TRACK_A, 1)] }),
      ]);

      await service.getPlaylist(OWNER_ID, PLAYLIST_ID);

      expect(tracks.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('asks nothing about withdrawn releases for a viewer', async () => {
      entries.find.mockResolvedValue([
        entryRow('entry-1', TRACK_A, 1),
        entryRow('entry-2', TRACK_B, 2),
      ]);
      queueBuilders(tracks, [
        queryBuilderMock({ many: [trackRow(TRACK_A, 1)] }),
      ]);

      const view = await service.getPlaylist(VIEWER_ID, PLAYLIST_ID);

      expect(tracks.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(
        view.entries.every((entry) => !('unavailableReason' in entry)),
      ).toBe(true);
    });

    it('counts and sums playable tracks only and keeps four distinct covers in playlist order', async () => {
      const stats = queryBuilderMock({
        raw: [
          {
            playlist_id: PLAYLIST_ID,
            track_count: '3',
            total_duration_seconds: '600',
          },
        ],
      });
      const covers = queryBuilderMock({
        raw: [
          {
            playlist_id: PLAYLIST_ID,
            cover_key: coverKey(3),
            first_position: 9,
          },
          {
            playlist_id: PLAYLIST_ID,
            cover_key: coverKey(1),
            first_position: 1,
          },
          {
            playlist_id: PLAYLIST_ID,
            cover_key: coverKey(5),
            first_position: 20,
          },
          {
            playlist_id: PLAYLIST_ID,
            cover_key: coverKey(2),
            first_position: 4,
          },
          {
            playlist_id: PLAYLIST_ID,
            cover_key: coverKey(4),
            first_position: 12,
          },
        ],
      });
      queueBuilders(entries, [stats, covers]);

      const view = await service.getPlaylist(VIEWER_ID, PLAYLIST_ID);

      expect(view.trackCount).toBe(3);
      expect(view.totalDurationSeconds).toBe(600);
      expect(view.coverUrls).toEqual(
        [1, 2, 3, 4].map(
          (index) => `https://api.test/files/${coverKey(index)}`,
        ),
      );
      for (const queryBuilder of [stats, covers]) {
        expect(
          predicatesOf(queryBuilder).some((predicate) =>
            predicate.includes(`"release"."status" = 'published'`),
          ),
        ).toBe(true);
        expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
          queryBuilder,
          VIEWER_ID,
          '"persona"."user_id"',
        );
      }
    });
  });

  describe('lists', () => {
    it('lists the owner playlists newest updated first, 24 to a page, with a cursor', async () => {
      const rows = Array.from({ length: 25 }, (_unused, index) =>
        playlistRow({
          id: `e3000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          updatedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, 25 - index)),
        }),
      );
      const listing = queryBuilderMock({ many: rows });
      queueBuilders(playlists, [listing]);

      const page = await service.listMine(OWNER_ID, undefined);

      expect(listing.where).toHaveBeenCalledWith(
        '"playlist"."user_id" = :ownerId',
        { ownerId: OWNER_ID },
      );
      expect(listing.limit).toHaveBeenCalledWith(25);
      expect(page.items).toHaveLength(24);
      expect(page.pageInfo).toEqual({
        hasMore: true,
        nextCursor: encodePlaylistCursor({
          updatedAt: rows[23]!.updatedAt,
          id: rows[23]!.id,
        }),
      });
    });

    it('lists only publicly listed playlists credited to the persona, minus blocked owners', async () => {
      const listing = queryBuilderMock();
      queueBuilders(playlists, [listing]);

      await service.listCreditedToPersona(VIEWER_ID, PERSONA_ID, undefined);

      expect(listing.where).toHaveBeenCalledWith(
        '"playlist"."credit_subprofile_id" = :creditSubprofileId',
        { creditSubprofileId: PERSONA_ID },
      );
      expect(predicatesOf(listing)).toContain(
        publiclyListedPlaylistSql('playlist'),
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        listing,
        VIEWER_ID,
        '"playlist"."user_id"',
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        listing,
        VIEWER_ID,
        ...personaCreatorFilterCall,
      );
    });

    it('shows the owner every playlist that reads as theirs on their own profile', async () => {
      const listing = queryBuilderMock();
      queueBuilders(playlists, [listing]);

      await service.listCreditedToMember(OWNER_ID, OWNER_SLUG, undefined);

      expect(predicatesOf(listing)).toContain(
        `NOT ${personaCreditActiveSql('playlist')}`,
      );
      expect(access.hasAccess).not.toHaveBeenCalled();
      expect(connections.areConnected).not.toHaveBeenCalled();
    });

    it('lists only member-credited playlists on a member profile, connections-only ones for connections alone', async () => {
      const connectionListing = queryBuilderMock();
      const strangerListing = queryBuilderMock();
      queueBuilders(playlists, [connectionListing, strangerListing]);
      connections.areConnected
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await service.listCreditedToMember(VIEWER_ID, OWNER_SLUG, undefined);
      await service.listCreditedToMember(VIEWER_ID, OWNER_SLUG, undefined);

      for (const listing of [connectionListing, strangerListing]) {
        expect(listing.where).toHaveBeenCalledWith(
          '"playlist"."user_id" = :ownerId',
          { ownerId: OWNER_ID },
        );
        expect(predicatesOf(listing)).toContain(
          '"playlist"."is_credited_to_persona" = false',
        );
      }
      expect(connectionListing.andWhere).toHaveBeenCalledWith(
        '"playlist"."visibility" IN (:...memberVisibilities)',
        { memberVisibilities: ['public', 'connections'] },
      );
      expect(strangerListing.andWhere).toHaveBeenCalledWith(
        '"playlist"."visibility" IN (:...memberVisibilities)',
        { memberVisibilities: ['public'] },
      );
      for (const listing of [connectionListing, strangerListing]) {
        expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
          listing,
          VIEWER_ID,
          '"playlist"."user_id"',
        );
      }
    });

    it.each([
      ['blocked either way', { isBlocked: true, hasGrant: true }],
      ['without a Studio grant', { isBlocked: false, hasGrant: false }],
    ])(
      'answers an empty page for a member %s, without listing',
      async (_label, { isBlocked, hasGrant }) => {
        blockFilter.isBlockedEitherWay.mockResolvedValue(isBlocked);
        access.hasAccess.mockResolvedValue(hasGrant);

        const page = await service.listCreditedToMember(
          VIEWER_ID,
          OWNER_SLUG,
          undefined,
        );

        expect(page).toEqual({
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        });
        expect(playlists.createQueryBuilder).not.toHaveBeenCalled();
      },
    );

    it('answers an empty page for a slug with no active member, before any other lookup', async () => {
      const slugLookup = queryBuilderMock({ many: [] });
      profiles.createQueryBuilder.mockReturnValue(slugLookup);

      const page = await service.listCreditedToMember(
        VIEWER_ID,
        'nobody-here',
        undefined,
      );

      expect(slugLookup.where).toHaveBeenCalledWith('p.slug IN (:...slugs)', {
        slugs: ['nobody-here'],
      });
      expect(page).toEqual({
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });
      expect(access.hasAccess).not.toHaveBeenCalled();
      expect(playlists.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('checks the track is visible first, then lists up to six public playlists holding it', async () => {
      const listing = queryBuilderMock();
      queueBuilders(playlists, [listing]);

      await service.listForTrack(VIEWER_ID, TRACK_A);

      expect(catalog.getTrack).toHaveBeenCalledWith(VIEWER_ID, TRACK_A);
      expect(listing.where).toHaveBeenCalledWith(
        expect.stringContaining('"track_entry"."track_id" = :entryTrackId'),
        { entryTrackId: TRACK_A },
      );
      expect(predicatesOf(listing)).toContain(
        publiclyListedPlaylistSql('playlist'),
      );
      expect(listing.limit).toHaveBeenCalledWith(6);
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        listing,
        VIEWER_ID,
        ...personaCreatorFilterCall,
      );
    });

    it('answers 404 for the playlists of a track the viewer cannot see', async () => {
      catalog.getTrack.mockRejectedValue(
        new NotFoundException('Track not found'),
      );
      await expect(
        service.listForTrack(VIEWER_ID, TRACK_A),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(playlists.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('searches public playlists by folded name, 20 at most', async () => {
      const listing = queryBuilderMock();
      queueBuilders(playlists, [listing]);

      await service.searchPlaylists(VIEWER_ID, '  Noite_50%  ');

      const searchCall = listing.where.mock.calls[0]!;
      expect(searchCall[0]).toContain('translate(lower(');
      expect(searchCall[0]).toContain(`ESCAPE '\\'`);
      expect(searchCall[1]).toEqual({
        playlistSearchPattern: '%Noite\\_50\\%%',
      });
      expect(predicatesOf(listing)).toContain(
        publiclyListedPlaylistSql('playlist'),
      );
      expect(listing.limit).toHaveBeenCalledWith(20);
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        listing,
        VIEWER_ID,
        ...personaCreatorFilterCall,
      );
    });

    it('keeps the persona creator filter off a member profile, which lists member credits only', async () => {
      const listing = queryBuilderMock();
      queueBuilders(playlists, [listing]);

      await service.listCreditedToMember(VIEWER_ID, OWNER_SLUG, undefined);

      expect(blockFilter.excludeBlocked).toHaveBeenCalledTimes(1);
    });
  });

  it('answers the playable subset of the ids it is asked about', async () => {
    queueBuilders(tracks, [queryBuilderMock({ many: [trackRow(TRACK_A, 1)] })]);
    await expect(
      service.playableTrackIds(VIEWER_ID, [TRACK_A, TRACK_B]),
    ).resolves.toEqual(new Set([TRACK_A]));
    await expect(service.playableTrackIds(VIEWER_ID, [])).resolves.toEqual(
      new Set(),
    );
  });
});
