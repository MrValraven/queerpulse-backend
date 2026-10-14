import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { ConnectionsService } from '../connections/connections.service';
import { foldedHaystack, foldedSearchTerm } from '../search/search-text';
import { BlockFilterService } from '../social/block-filter.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { StudioPlaylistTrack } from './entities/studio-playlist-track.entity';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioAccessService } from './studio-access.service';
import { StudioCatalogService } from './studio-catalog.service';
import {
  decodePlaylistCursor,
  encodePlaylistCursor,
} from './studio-playlist-cursor';
import {
  EMPTY_PLAYLIST_STATS,
  StudioPlaylistCard,
  StudioPlaylistEntryResponse,
  StudioPlaylistEntryTrack,
  StudioPlaylistList,
  StudioPlaylistPlayableStats,
  StudioPlaylistResponse,
  toStudioPlaylistCard,
  toStudioPlaylistResponse,
} from './studio-playlist-response';
import {
  canViewerOpenPlaylist,
  creditPersonaCreatorIdSql,
  effectivePlaylistVisibility,
  isPlaylistCreditBroken,
  personaCreatorBlockExemptSql,
  personaCreditActiveSql,
  playableTrackSql,
  publiclyListedPlaylistSql,
} from './studio-playlist-visibility';
import {
  StudioArtistPersona,
  StudioPage,
  toStudioTrackSummary,
} from './studio-response';
import { withdrawnReleaseSql } from './studio-visibility';
import { STUDIO_LIMITS } from './studio.constants';

interface PlaylistStatsRow {
  playlist_id: string;
  track_count: number | string;
  total_duration_seconds: number | string;
}

interface PlaylistCoverRow {
  playlist_id: string;
  cover_key: string;
  first_position: number | string;
}

const EMPTY_PLAYLIST_PAGE: StudioPage<StudioPlaylistCard> = {
  items: [],
  pageInfo: { hasMore: false, nextCursor: null },
};

/**
 * Studio v2: every playlist read. The matrix lives in
 * `studio-playlist-visibility.ts`; this service gathers the facts it needs
 * and builds cards and entries through the same playability rule the
 * listening reads use (`playableTrackSql` plus the block filter on the
 * artist), so a card's count, length and covers and the playlist page's
 * entries always agree. A playlist the viewer cannot open answers 404, so
 * its existence never leaks. Persona credits that stopped standing read as
 * private: the owner sees them under their own name, everyone else never
 * receives them (filtered out of every list, 404 by link).
 */
@Injectable()
export class StudioPlaylistReadsService {
  constructor(
    @InjectRepository(StudioPlaylist)
    private readonly playlists: Repository<StudioPlaylist>,
    @InjectRepository(StudioPlaylistTrack)
    private readonly entries: Repository<StudioPlaylistTrack>,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly catalog: StudioCatalogService,
    private readonly access: StudioAccessService,
    private readonly blockFilter: BlockFilterService,
    private readonly connections: ConnectionsService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async getPlaylist(
    viewerId: string,
    playlistId: string,
  ): Promise<StudioPlaylistResponse> {
    const playlist = await this.playlists.findOne({
      where: { id: playlistId },
    });
    if (!playlist) {
      throw new NotFoundException('Playlist not found');
    }
    const standingCreditIds = await this.standingPersonaCreditIds([playlist]);
    const isOwner = playlist.userId === viewerId;
    if (
      !isOwner &&
      !(await this.canOpen(
        viewerId,
        playlist,
        isPlaylistCreditBroken(playlist, standingCreditIds),
      ))
    ) {
      throw new NotFoundException('Playlist not found');
    }
    const [card] = await this.toCards(viewerId, [playlist], standingCreditIds);
    if (!card) {
      throw new NotFoundException('Playlist not found');
    }
    const entries = await this.entriesFor(viewerId, playlist.id, isOwner);
    const isCreditBroken =
      playlist.isCreditedToPersona && card.credit.persona === null;
    return toStudioPlaylistResponse(card, playlist, entries, isCreditBroken);
  }

  /** `GET /studio/playlists/mine`: every playlist the caller owns. */
  listMine(
    viewerId: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioPlaylistCard>> {
    const queryBuilder = this.playlists
      .createQueryBuilder('playlist')
      .where('"playlist"."user_id" = :ownerId', { ownerId: viewerId });
    return this.pageOfCards(viewerId, queryBuilder, cursor);
  }

  /** The persona page: public playlists credited to the persona. */
  listCreditedToPersona(
    viewerId: string,
    subprofileId: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioPlaylistCard>> {
    const queryBuilder = this.playlists
      .createQueryBuilder('playlist')
      .where('"playlist"."credit_subprofile_id" = :creditSubprofileId', {
        creditSubprofileId: subprofileId,
      })
      .andWhere(publiclyListedPlaylistSql('playlist'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"playlist"."user_id"',
    );
    this.excludeBlockedPersonaCreator(queryBuilder, viewerId);
    return this.pageOfCards(viewerId, queryBuilder, cursor);
  }

  /** `StudioArtist.playlists`: the first page of the persona's playlists. */
  async listForArtistView(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioPlaylistCard[]> {
    return (await this.listCreditedToPersona(viewerId, subprofileId, undefined))
      .items;
  }

  /**
   * The member profile, addressed by profile slug (the profile page knows no
   * user id). The slug resolves through `MemberLookup.userIdForSlug`, the
   * profile read's existence rule: a profile row with that slug whose
   * account is active. An unknown or inactive slug is an empty page. The
   * owner sees every playlist that reads as theirs (member credits and
   * broken persona credits). Anyone else sees member credits only: public
   * ones, plus connections-only ones when they are an accepted connection. A
   * persona-credited playlist never appears here, so a member profile never
   * tells anyone which personas the member runs.
   */
  async listCreditedToMember(
    viewerId: string,
    memberSlug: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioPlaylistCard>> {
    const memberUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!memberUserId) {
      return EMPTY_PLAYLIST_PAGE;
    }
    if (viewerId === memberUserId) {
      const ownerQueryBuilder = this.playlists
        .createQueryBuilder('playlist')
        .where('"playlist"."user_id" = :ownerId', { ownerId: memberUserId })
        .andWhere(`NOT ${personaCreditActiveSql('playlist')}`);
      return this.pageOfCards(viewerId, ownerQueryBuilder, cursor);
    }
    const [hasOwnerGrant, isBlockedEitherWay] = await Promise.all([
      this.access.hasAccess(memberUserId),
      this.blockFilter.isBlockedEitherWay(viewerId, memberUserId),
    ]);
    if (!hasOwnerGrant || isBlockedEitherWay) {
      return EMPTY_PLAYLIST_PAGE;
    }
    const isConnected = await this.connections.areConnected(
      viewerId,
      memberUserId,
    );
    const memberVisibilities = isConnected
      ? [StudioPlaylistVisibility.Public, StudioPlaylistVisibility.Connections]
      : [StudioPlaylistVisibility.Public];
    const queryBuilder = this.playlists
      .createQueryBuilder('playlist')
      .where('"playlist"."user_id" = :ownerId', { ownerId: memberUserId })
      .andWhere('"playlist"."is_credited_to_persona" = false')
      .andWhere('"playlist"."visibility" IN (:...memberVisibilities)', {
        memberVisibilities,
      });
    // The check above already answered; the filter keeps a block placed
    // between the two reads out of the page too.
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"playlist"."user_id"',
    );
    return this.pageOfCards(viewerId, queryBuilder, cursor);
  }

  /** "In these playlists" on a track page: up to six public playlists. */
  async listForTrack(
    viewerId: string,
    trackId: string,
  ): Promise<StudioPlaylistList> {
    // The track page's own gate: a track the viewer cannot see is a 404.
    await this.catalog.getTrack(viewerId, trackId);
    const queryBuilder = this.playlists
      .createQueryBuilder('playlist')
      .where(
        `EXISTS (
          SELECT 1 FROM "studio_playlist_tracks" "track_entry"
           WHERE "track_entry"."playlist_id" = "playlist"."id"
             AND "track_entry"."track_id" = :entryTrackId
        )`,
        { entryTrackId: trackId },
      )
      .andWhere(publiclyListedPlaylistSql('playlist'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"playlist"."user_id"',
    );
    this.excludeBlockedPersonaCreator(queryBuilder, viewerId);
    const rows = await queryBuilder
      .orderBy('playlist.updatedAt', 'DESC')
      .addOrderBy('playlist.id', 'DESC')
      .limit(STUDIO_LIMITS.playlistsOnTrackPage)
      .getMany();
    return { items: await this.toCards(viewerId, rows) };
  }

  /** Search: public playlists matched on name with accent folding. */
  async searchPlaylists(
    viewerId: string,
    query: string,
  ): Promise<StudioPlaylistCard[]> {
    const searchPattern = `%${escapeLikeTerm(query.trim())}%`;
    const queryBuilder = this.playlists
      .createQueryBuilder('playlist')
      .where(
        `${foldedHaystack('playlist', ['name'])} LIKE ${foldedSearchTerm('playlistSearchPattern')} ESCAPE '\\'`,
        { playlistSearchPattern: searchPattern },
      )
      .andWhere(publiclyListedPlaylistSql('playlist'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"playlist"."user_id"',
    );
    this.excludeBlockedPersonaCreator(queryBuilder, viewerId);
    const rows = await queryBuilder
      .orderBy('playlist.updatedAt', 'DESC')
      .addOrderBy('playlist.id', 'DESC')
      .limit(STUDIO_LIMITS.searchResultsPerType)
      .getMany();
    return this.toCards(viewerId, rows);
  }

  /** The ids among `trackIds` this viewer can play right now. */
  async playableTrackIds(
    viewerId: string,
    trackIds: string[],
  ): Promise<Set<string>> {
    return new Set((await this.playableTracks(viewerId, trackIds)).keys());
  }

  // The direct-link decision for a non-owner. Private (stored, or because the
  // credit stopped standing) answers before any lookup. The owner must be
  // active as well as granted, and a persona credit also needs no block
  // either way with the member who created the persona.
  private async canOpen(
    viewerId: string,
    playlist: StudioPlaylist,
    isCreditBroken: boolean,
  ): Promise<boolean> {
    const visibility = effectivePlaylistVisibility(
      playlist.visibility,
      isCreditBroken,
    );
    if (visibility === StudioPlaylistVisibility.Private) {
      return false;
    }
    const creditSubprofileId = playlist.isCreditedToPersona
      ? playlist.creditSubprofileId
      : null;
    const [
      hasAccess,
      isOwnerActive,
      isBlockedWithOwner,
      isBlockedWithPersonaCreator,
    ] = await Promise.all([
      this.access.hasAccess(playlist.userId),
      this.users.exists({
        where: { id: playlist.userId, status: UserStatus.Active },
      }),
      this.blockFilter.isBlockedEitherWay(viewerId, playlist.userId),
      creditSubprofileId
        ? this.isBlockedWithPersonaCreator(viewerId, creditSubprofileId)
        : Promise.resolve(false),
    ]);
    const hasOwnerGrant = hasAccess && isOwnerActive;
    const isBlockedEitherWay =
      isBlockedWithOwner || isBlockedWithPersonaCreator;
    const shouldAskConnection =
      visibility === StudioPlaylistVisibility.Connections &&
      hasOwnerGrant &&
      !isBlockedEitherWay;
    const isConnectedToOwner = shouldAskConnection
      ? await this.connections.areConnected(viewerId, playlist.userId)
      : false;
    return canViewerOpenPlaylist({
      isOwner: false,
      visibility: playlist.visibility,
      isCreditBroken,
      hasOwnerGrant,
      isBlockedEitherWay,
      isConnectedToOwner,
    });
  }

  private async isBlockedWithPersonaCreator(
    viewerId: string,
    subprofileId: string,
  ): Promise<boolean> {
    const persona = await this.subprofiles.findOne({
      where: { id: subprofileId },
      select: { id: true, userId: true },
    });
    return persona
      ? this.blockFilter.isBlockedEitherWay(viewerId, persona.userId)
      : false;
  }

  // A co-owned persona: a playlist credited to it stays out of a list when
  // the viewer and the member who created the persona are blocked either
  // way. Member credits and the owner's own playlists pass. A second
  // `excludeBlocked` on the same builder binds `blockFilterActorId` to the
  // same viewer, so the two calls agree.
  private excludeBlockedPersonaCreator(
    queryBuilder: SelectQueryBuilder<StudioPlaylist>,
    viewerId: string,
  ): void {
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      creditPersonaCreatorIdSql('playlist'),
      {
        unless: personaCreatorBlockExemptSql('playlist', 'blockFilterActorId'),
      },
    );
  }

  private async pageOfCards(
    viewerId: string,
    queryBuilder: SelectQueryBuilder<StudioPlaylist>,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioPlaylistCard>> {
    const pageSize = STUDIO_LIMITS.playlistsPerPage;
    const decodedCursor = decodePlaylistCursor(cursor);
    if (decodedCursor) {
      queryBuilder.andWhere(
        '("playlist"."updated_at", "playlist"."id") < (:cursorUpdatedAt, :cursorId)',
        {
          cursorUpdatedAt: decodedCursor.updatedAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    const rows = await queryBuilder
      .orderBy('playlist.updatedAt', 'DESC')
      .addOrderBy('playlist.id', 'DESC')
      .limit(pageSize + 1)
      .getMany();
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items: await this.toCards(viewerId, pageRows),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && lastRow
            ? encodePlaylistCursor({
                updatedAt: lastRow.updatedAt,
                id: lastRow.id,
              })
            : null,
      },
    };
  }

  // Cards for playlists already known to be readable by the viewer as a list
  // or a link. A playlist whose persona credit does not stand is kept for
  // its owner (as private, under their own name) and dropped for everyone
  // else.
  private async toCards(
    viewerId: string,
    playlists: StudioPlaylist[],
    knownStandingCreditIds?: ReadonlySet<string>,
  ): Promise<StudioPlaylistCard[]> {
    if (!playlists.length) {
      return [];
    }
    const playlistIds = playlists.map((playlist) => playlist.id);
    const standingCreditIds =
      knownStandingCreditIds ??
      (await this.standingPersonaCreditIds(playlists));
    const personaById = await this.creditPersonas([
      ...new Set(
        playlists.flatMap((playlist) =>
          playlist.creditSubprofileId && standingCreditIds.has(playlist.id)
            ? [playlist.creditSubprofileId]
            : [],
        ),
      ),
    ]);
    const creditPersonaOf = (
      playlist: StudioPlaylist,
    ): StudioArtistPersona | undefined =>
      playlist.creditSubprofileId && standingCreditIds.has(playlist.id)
        ? personaById.get(playlist.creditSubprofileId)
        : undefined;
    const isBrokenFor = (playlist: StudioPlaylist): boolean =>
      playlist.isCreditedToPersona && creditPersonaOf(playlist) === undefined;
    const memberCreditedOwnerIds = [
      ...new Set(
        playlists
          .filter(
            (playlist) =>
              !playlist.isCreditedToPersona || isBrokenFor(playlist),
          )
          .map((playlist) => playlist.userId),
      ),
    ];
    const memberById: Map<string, MemberRef> = memberCreditedOwnerIds.length
      ? await new MemberLookup(this.profiles).byUserIds(memberCreditedOwnerIds)
      : new Map<string, MemberRef>();
    const statsByPlaylistId = await this.playableStatsFor(
      viewerId,
      playlistIds,
    );
    const coverKeysByPlaylistId = await this.coverKeysFor(
      viewerId,
      playlistIds,
    );
    return playlists.flatMap((playlist) => {
      const isCreditBroken = isBrokenFor(playlist);
      if (playlist.userId !== viewerId && isCreditBroken) {
        return [];
      }
      return [
        toStudioPlaylistCard({
          playlist,
          viewerId,
          isCreditBroken,
          persona: creditPersonaOf(playlist),
          member: memberById.get(playlist.userId),
          stats: statsByPlaylistId.get(playlist.id) ?? EMPTY_PLAYLIST_STATS,
          coverKeys: coverKeysByPlaylistId.get(playlist.id) ?? [],
        }),
      ];
    });
  }

  // The playlists among these whose persona credit stands right now. One
  // query, skipped when none carries a persona credit.
  private async standingPersonaCreditIds(
    playlists: StudioPlaylist[],
  ): Promise<Set<string>> {
    const creditedPlaylistIds = playlists
      .filter((playlist) => playlist.isCreditedToPersona)
      .map((playlist) => playlist.id);
    if (!creditedPlaylistIds.length) {
      return new Set();
    }
    const rows = await this.playlists
      .createQueryBuilder('playlist')
      .select('"playlist"."id"', 'playlist_id')
      .where('"playlist"."id" IN (:...creditedPlaylistIds)', {
        creditedPlaylistIds,
      })
      .andWhere(personaCreditActiveSql('playlist'))
      .getRawMany<{ playlist_id: string }>();
    return new Set(rows.map((row) => row.playlist_id));
  }

  private async creditPersonas(
    subprofileIds: string[],
  ): Promise<Map<string, StudioArtistPersona>> {
    if (!subprofileIds.length) {
      return new Map();
    }
    const personas = await this.subprofiles.find({
      where: { id: In(subprofileIds) },
      select: {
        id: true,
        handle: true,
        displayName: true,
        kind: true,
        avatarUrl: true,
      },
    });
    return new Map(personas.map((persona) => [persona.id, persona]));
  }

  // Entries joined to the tracks this viewer can play. Both card queries use
  // it, so a card counts what the playlist page plays.
  private playableEntries(
    viewerId: string,
    playlistIds: string[],
  ): SelectQueryBuilder<StudioPlaylistTrack> {
    const queryBuilder = this.entries
      .createQueryBuilder('entry')
      .innerJoin('entry.track', 'track')
      .innerJoin('track.release', 'release')
      .innerJoin('release.subprofile', 'persona')
      .where('"entry"."playlist_id" IN (:...cardPlaylistIds)', {
        cardPlaylistIds: playlistIds,
      })
      .andWhere(playableTrackSql('track', 'release', 'persona'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    return queryBuilder;
  }

  private async playableStatsFor(
    viewerId: string,
    playlistIds: string[],
  ): Promise<Map<string, StudioPlaylistPlayableStats>> {
    const rows = await this.playableEntries(viewerId, playlistIds)
      .select('"entry"."playlist_id"', 'playlist_id')
      .addSelect('COUNT(*)::int', 'track_count')
      .addSelect(
        'COALESCE(SUM("track"."duration_seconds"), 0)::int',
        'total_duration_seconds',
      )
      .groupBy('"entry"."playlist_id"')
      .getRawMany<PlaylistStatsRow>();
    return new Map(
      rows.map((row) => [
        row.playlist_id,
        {
          trackCount: Number(row.track_count),
          totalDurationSeconds: Number(row.total_duration_seconds),
        },
      ]),
    );
  }

  // Each playable release cover once per playlist, at the position of its
  // first track there; the card keeps the first four.
  private async coverKeysFor(
    viewerId: string,
    playlistIds: string[],
  ): Promise<Map<string, string[]>> {
    const rows = await this.playableEntries(viewerId, playlistIds)
      .select('"entry"."playlist_id"', 'playlist_id')
      .addSelect('"release"."cover_key"', 'cover_key')
      .addSelect('MIN("entry"."position")', 'first_position')
      .andWhere('"release"."cover_key" IS NOT NULL')
      .groupBy('"entry"."playlist_id"')
      .addGroupBy('"release"."cover_key"')
      .getRawMany<PlaylistCoverRow>();
    const coverKeysByPlaylistId = new Map<string, string[]>();
    const orderedRows = [...rows].sort(
      (leftRow, rightRow) =>
        Number(leftRow.first_position) - Number(rightRow.first_position),
    );
    for (const row of orderedRows) {
      const coverKeys = coverKeysByPlaylistId.get(row.playlist_id) ?? [];
      if (coverKeys.length < STUDIO_LIMITS.playlistCoverCount) {
        coverKeys.push(row.cover_key);
      }
      coverKeysByPlaylistId.set(row.playlist_id, coverKeys);
    }
    return coverKeysByPlaylistId;
  }

  private async entriesFor(
    viewerId: string,
    playlistId: string,
    isOwner: boolean,
  ): Promise<StudioPlaylistEntryResponse[]> {
    const rows = await this.entries.find({
      where: { playlistId },
      order: { position: 'ASC', id: 'ASC' },
    });
    const playable = await this.playableTracks(
      viewerId,
      rows.flatMap((row) => (row.trackId ? [row.trackId] : [])),
    );
    const releaseCards = await this.catalog.cardsByReleaseId([
      ...new Set([...playable.values()].map((track) => track.releaseId)),
    ]);
    const resolved = rows.map((row) => {
      const track = row.trackId ? playable.get(row.trackId) : undefined;
      const release = track ? releaseCards.get(track.releaseId) : undefined;
      const entryTrack: StudioPlaylistEntryTrack | null =
        track && release ? { ...toStudioTrackSummary(track), release } : null;
      return { row, entryTrack };
    });
    const visible = isOwner
      ? resolved
      : resolved.filter((entry) => entry.entryTrack !== null);
    // Studio open demo pages: the owner learns which unavailable rows staff
    // took down. Viewers never receive an unavailable row, so they never ask.
    const withdrawnTrackIds = isOwner
      ? await this.withdrawnTrackIds(
          viewerId,
          visible.flatMap((entry) =>
            entry.entryTrack === null && entry.row.trackId
              ? [entry.row.trackId]
              : [],
          ),
        )
      : new Set<string>();
    return visible.map((entry, index) => {
      const isAvailable = entry.entryTrack !== null;
      const isWithdrawn =
        !isAvailable &&
        entry.row.trackId !== null &&
        withdrawnTrackIds.has(entry.row.trackId);
      return {
        entryId: entry.row.id,
        position: index + 1,
        addedAt: entry.row.addedAt.toISOString(),
        isAvailable,
        track: entry.entryTrack,
        ...(isWithdrawn ? { unavailableReason: 'withdrawn' as const } : {}),
      };
    });
  }

  private async playableTracks(
    viewerId: string,
    trackIds: string[],
  ): Promise<Map<string, StudioTrack>> {
    if (!trackIds.length) {
      return new Map();
    }
    const queryBuilder = this.tracks
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .innerJoin('release.subprofile', 'persona')
      .where('track.id IN (:...playableTrackIds)', {
        playableTrackIds: trackIds,
      })
      .andWhere(playableTrackSql('track', 'release', 'persona'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    const playableTracks = await queryBuilder.getMany();
    return new Map(playableTracks.map((track) => [track.id, track]));
  }

  // Tracks whose release staff took down while it was live, of a persona the
  // owner can still hear (`withdrawnReleaseSql`), blocks either way applied.
  private async withdrawnTrackIds(
    viewerId: string,
    trackIds: string[],
  ): Promise<Set<string>> {
    if (!trackIds.length) {
      return new Set();
    }
    const queryBuilder = this.tracks
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .innerJoin('release.subprofile', 'persona')
      .select('"track"."id"', 'track_id')
      .where('track.id IN (:...withdrawnTrackIds)', {
        withdrawnTrackIds: trackIds,
      })
      .andWhere(withdrawnReleaseSql('release', 'persona'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    const rows = await queryBuilder.getRawMany<{ track_id: string }>();
    return new Set(rows.map((row) => row.track_id));
  }
}
