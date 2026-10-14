import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  StudioReleaseCursor,
  decodeStudioCursor,
  encodeStudioCursor,
} from './studio-cursor';
import {
  StudioLikedTrackEntry,
  StudioLikedTracksPage,
} from './studio-liked-tracks-response';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { StudioPlaylistEntryTrack } from './studio-playlist-response';
import { playableTrackSql } from './studio-playlist-visibility';
import { StudioReleaseCard, toStudioTrackSummary } from './studio-response';
import { STUDIO_LIMITS } from './studio.constants';

/** `saved_item.subject_id` is a varchar: only a uuid may reach a uuid lookup. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid-shaped subject id in the lowercase form the catalog stores. */
function trackIdOf(subjectId: string): string {
  return UUID_PATTERN.test(subjectId) ? subjectId.toLowerCase() : subjectId;
}

/** The caller's liked track ids as uuids, for an indexed `IN` probe. */
const LIKED_TRACK_IDS_SQL = `"track"."id" IN (
  SELECT CASE
           WHEN "liked"."subject_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN lower("liked"."subject_id")::uuid
         END
    FROM "saved_item" "liked"
   WHERE "liked"."user_id" = :likedOwnerId
     AND "liked"."subject_type" = 'studio_track'
)`;

/**
 * `saved_item.created_at` keeps microseconds and the cursor carries a JS
 * `Date` (milliseconds), so the order, the keyset and the position count all
 * read the column at millisecond precision. A same-millisecond row at a page
 * boundary then falls to the id tiebreak and is never skipped.
 */
const LIKED_AT_SQL = `date_trunc('milliseconds', "saved"."created_at")`;

interface LikedRow {
  saved_id: string;
  subject_id: string;
  saved_title: string;
  created_at: Date | string;
  liked_at: Date | string;
}

type UnpositionedLikedEntry = Omit<StudioLikedTrackEntry, 'position'>;

interface LikedStatsRow {
  track_count: number | string;
  total_duration_seconds: number | string;
}

/**
 * Liked songs: every member's default private playlist, backed by their own
 * `studio_track` saves. Reads only the caller's saves, newest first, and
 * resolves each through the playlist playability rule and the block filter
 * (`StudioPlaylistReadsService.playableTracks`), so a liked row plays
 * exactly what a playlist entry for the same track would. Records nothing.
 */
@Injectable()
export class StudioLikedTracksService {
  constructor(
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    private readonly playlistReads: StudioPlaylistReadsService,
    private readonly catalog: StudioCatalogService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  async listLiked(
    viewerId: string,
    cursor: string | undefined,
  ): Promise<StudioLikedTracksPage> {
    const pageSize = STUDIO_LIMITS.likedTracksPerPage;
    const decodedCursor = decodeStudioCursor(cursor);
    const pageQuery = this.ownLikes(viewerId)
      .select('"saved"."id"', 'saved_id')
      .addSelect('"saved"."subject_id"', 'subject_id')
      .addSelect('"saved"."title"', 'saved_title')
      .addSelect('"saved"."created_at"', 'created_at')
      .addSelect(LIKED_AT_SQL, 'liked_at');
    if (decodedCursor) {
      pageQuery.andWhere(
        `(${LIKED_AT_SQL}, "saved"."id") < (:cursorLikedAt, :cursorId)`,
        {
          cursorLikedAt: decodedCursor.publishedAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    const rows = await pageQuery
      .orderBy(LIKED_AT_SQL, 'DESC')
      .addOrderBy('"saved"."id"', 'DESC')
      .limit(pageSize + 1)
      .getRawMany<LikedRow>();
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const [positionOffset, entries, stats] = await Promise.all([
      decodedCursor
        ? this.countAtOrAfter(viewerId, decodedCursor)
        : Promise.resolve(0),
      this.entriesFor(viewerId, pageRows),
      // The totals cover the whole set, so the first page carries them and
      // a cursor page answers zeros.
      decodedCursor ? Promise.resolve(undefined) : this.statsFor(viewerId),
    ]);
    return {
      items: entries.map((entry, index) => ({
        ...entry,
        position: positionOffset + index + 1,
      })),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && lastRow
            ? encodeStudioCursor({
                publishedAt: new Date(lastRow.liked_at),
                id: lastRow.saved_id,
              })
            : null,
      },
      trackCount: Number(stats?.track_count ?? 0),
      totalDurationSeconds: Number(stats?.total_duration_seconds ?? 0),
    };
  }

  // The caller's own likes. Every read here starts from this predicate.
  private ownLikes(viewerId: string): SelectQueryBuilder<SavedItem> {
    return this.savedItems
      .createQueryBuilder('saved')
      .where('"saved"."user_id" = :likedOwnerId', { likedOwnerId: viewerId })
      .andWhere(`"saved"."subject_type" = 'studio_track'`);
  }

  // How many likes the earlier pages held: those at or after the cursor in
  // newest-first order. Positions then stay contiguous across pages. They
  // are best-effort: a like added or removed between page loads shifts them.
  private countAtOrAfter(
    viewerId: string,
    decodedCursor: StudioReleaseCursor,
  ): Promise<number> {
    return this.ownLikes(viewerId)
      .andWhere(
        `(${LIKED_AT_SQL}, "saved"."id") >= (:cursorLikedAt, :cursorId)`,
        {
          cursorLikedAt: decodedCursor.publishedAt,
          cursorId: decodedCursor.id,
        },
      )
      .getCount();
  }

  // Mirrors `StudioPlaylistReadsService.entriesFor` in the owner's view:
  // every row comes back, an unplayable one with `track: null`. Positions
  // are set by the caller.
  private async entriesFor(
    viewerId: string,
    rows: LikedRow[],
  ): Promise<UnpositionedLikedEntry[]> {
    const uuidTrackIds = rows
      .map((row) => row.subject_id)
      .filter((subjectId) => UUID_PATTERN.test(subjectId))
      .map(trackIdOf);
    const playable = uuidTrackIds.length
      ? await this.playlistReads.playableTracks(viewerId, uuidTrackIds)
      : new Map<string, StudioTrack>();
    const releaseIds = [
      ...new Set([...playable.values()].map((track) => track.releaseId)),
    ];
    const releaseCards = releaseIds.length
      ? await this.catalog.cardsByReleaseId(releaseIds)
      : new Map<string, StudioReleaseCard>();
    const resolved = rows.map((row) => {
      // The lowercase form keys the catalog lookups; the stored id goes back
      // to the client, so its saved-store match and unlike keep working.
      const lookupTrackId = trackIdOf(row.subject_id);
      const track = playable.get(lookupTrackId);
      const release = track ? releaseCards.get(track.releaseId) : undefined;
      const entryTrack: StudioPlaylistEntryTrack | null =
        track && release ? { ...toStudioTrackSummary(track), release } : null;
      return { row, lookupTrackId, entryTrack };
    });
    const unavailableTrackIds = resolved.flatMap((entry) =>
      entry.entryTrack === null && UUID_PATTERN.test(entry.lookupTrackId)
        ? [entry.lookupTrackId]
        : [],
    );
    const withdrawnTrackIds = unavailableTrackIds.length
      ? await this.playlistReads.withdrawnTrackIds(
          viewerId,
          unavailableTrackIds,
        )
      : new Set<string>();
    return resolved.map((entry) => {
      const isAvailable = entry.entryTrack !== null;
      const isWithdrawn =
        !isAvailable && withdrawnTrackIds.has(entry.lookupTrackId);
      return {
        entryId: entry.row.saved_id,
        addedAt: new Date(entry.row.created_at).toISOString(),
        isAvailable,
        track: entry.entryTrack,
        ...(isWithdrawn ? { unavailableReason: 'withdrawn' as const } : {}),
        trackId: entry.row.subject_id,
        savedTitle: entry.row.saved_title,
      };
    });
  }

  // Count and length of every playable liked track, under the same rule
  // the page rows use. Driven from the caller's likes: the subquery turns
  // each uuid-shaped subject id into a uuid (any other id reads as NULL and
  // matches nothing), so the catalog is probed by primary key.
  private async statsFor(viewerId: string): Promise<LikedStatsRow | undefined> {
    const queryBuilder = this.tracks
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .innerJoin('release.subprofile', 'persona')
      .select('COUNT(*)::int', 'track_count')
      .addSelect(
        'COALESCE(SUM("track"."duration_seconds"), 0)::int',
        'total_duration_seconds',
      )
      .where(playableTrackSql('track', 'release', 'persona'))
      .andWhere(LIKED_TRACK_IDS_SQL, { likedOwnerId: viewerId });
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    return queryBuilder.getRawOne<LikedStatsRow>();
  }
}
