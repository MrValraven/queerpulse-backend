import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AddStudioPlaylistTracksDto } from './dto/add-studio-playlist-tracks.dto';
import { CreateStudioPlaylistDto } from './dto/create-studio-playlist.dto';
import { ReorderStudioPlaylistEntriesDto } from './dto/reorder-studio-playlist-entries.dto';
import { UpdateStudioPlaylistDto } from './dto/update-studio-playlist.dto';
import { StudioPlaylistTrack } from './entities/studio-playlist-track.entity';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { StudioPlaylistResponse } from './studio-playlist-response';
import { personaCreditActiveSql } from './studio-playlist-visibility';
import { isSameTrackSet } from './studio-tracks.service';
import { STUDIO_LIMITS, studioError } from './studio.constants';

/** Positions 1..n in stored order, in one statement. Touches only rows
 *  whose position moves; the deferrable unique constraint checks the set at
 *  statement end. */
export const RENUMBER_PLAYLIST_ENTRIES_SQL = `UPDATE "studio_playlist_tracks" AS "entry"
   SET "position" = "ordered"."new_position"
  FROM (
    SELECT "id", (row_number() OVER (ORDER BY "position", "id"))::smallint AS "new_position"
      FROM "studio_playlist_tracks"
     WHERE "playlist_id" = $1
  ) AS "ordered"
 WHERE "entry"."id" = "ordered"."id"
   AND "entry"."position" <> "ordered"."new_position"`;

/** Appends `$2` in order after the `$3` entries already there. */
export const APPEND_PLAYLIST_ENTRIES_SQL = `INSERT INTO "studio_playlist_tracks" ("playlist_id", "track_id", "position")
SELECT $1::uuid, "added"."track_id", ($3::int + "added"."ordinal")::smallint
  FROM unnest($2::uuid[]) WITH ORDINALITY AS "added"("track_id", "ordinal")`;

export const REORDER_PLAYLIST_ENTRIES_SQL = `UPDATE "studio_playlist_tracks" AS "entry"
   SET "position" = "ordering"."position"
  FROM unnest($2::uuid[], $3::smallint[]) AS "ordering"("entry_id", "position")
 WHERE "entry"."id" = "ordering"."entry_id" AND "entry"."playlist_id" = $1`;

/** Lock order for a credit change: persona row first, playlist row second.
 *  A persona save holds its subprofile row FOR UPDATE and then updates the
 *  playlists credited to it, while the foreign key check on a new credit
 *  takes FOR KEY SHARE on that subprofile. Taking the key share before the
 *  playlist lock keeps the two paths in one order, so they queue and cannot
 *  deadlock. No row back means the persona is gone. */
export const LOCK_CREDIT_PERSONA_SQL = `SELECT "id" FROM "subprofiles" WHERE "id" = $1 FOR KEY SHARE`;

/** Lock order for an add: playlist row, then the added tracks, then the
 *  entries, the order a persona delete or unlink takes them in. The key share
 *  holds each added track in place until the insert commits; a track deleted
 *  or re-keyed since the playable read comes back missing. */
export const LOCK_ADDED_TRACKS_SQL = `SELECT "id" FROM "studio_tracks" WHERE "id" = ANY($1::uuid[]) FOR KEY SHARE`;

/** Entry writes change the playlist, so lists show it as recently updated. */
export const TOUCH_PLAYLIST_SQL = `UPDATE "studio_playlists" SET "updated_at" = now() WHERE "id" = $1`;

/** Postgres `deadlock_detected`. */
const POSTGRES_DEADLOCK_DETECTED = '40P01';

/** True for a Postgres deadlock as TypeORM surfaces it: the SQLSTATE sits on
 *  the error itself or on its wrapped `driverError`. */
export function isDeadlockError(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    driverError?: { code?: string };
  } | null;
  return (
    candidate?.code === POSTGRES_DEADLOCK_DETECTED ||
    candidate?.driverError?.code === POSTGRES_DEADLOCK_DETECTED
  );
}

function toStoredDescription(
  description: string | null | undefined,
): string | null {
  return description?.trim() || null;
}

/**
 * Studio v2 playlist writes. Owner-only: the playlist row is read under
 * `pessimistic_write` and anyone but its owner gets 404, so a write never
 * confirms a playlist exists. Each write answers with the owner view.
 */
@Injectable()
export class StudioPlaylistWritesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
    private readonly playlistReads: StudioPlaylistReadsService,
  ) {}

  async create(
    userId: string,
    body: CreateStudioPlaylistDto,
  ): Promise<StudioPlaylistResponse> {
    const creditSubprofileId = body.creditSubprofileId?.toLowerCase() ?? null;
    const playlistId = await this.dataSource.transaction(async (manager) => {
      // Serializes one member's creates, so two at once cannot both pass
      // the limit (the persona create takes the same kind of lock).
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `studio_playlist_create:${userId}`,
      ]);
      if (creditSubprofileId) {
        await this.lockAllowedCredit(manager, userId, creditSubprofileId);
      }
      const playlistCount = await manager.count(StudioPlaylist, {
        where: { userId },
      });
      if (playlistCount >= STUDIO_LIMITS.playlistsPerMember) {
        throw studioError('studio_playlist_limit');
      }
      const saved = await manager.save(
        manager.create(StudioPlaylist, {
          userId,
          name: body.name,
          description: toStoredDescription(body.description),
          visibility: body.visibility,
          creditSubprofileId,
          isCreditedToPersona: creditSubprofileId !== null,
        }),
      );
      return saved.id;
    });
    return this.playlistReads.getPlaylist(userId, playlistId);
  }

  async update(
    userId: string,
    playlistId: string,
    body: UpdateStudioPlaylistDto,
  ): Promise<StudioPlaylistResponse> {
    const creditSubprofileId =
      body.creditSubprofileId === undefined
        ? undefined
        : (body.creditSubprofileId?.toLowerCase() ?? null);
    await this.dataSource.transaction(async (manager) => {
      if (creditSubprofileId) {
        await this.lockAllowedCredit(manager, userId, creditSubprofileId);
      }
      const { playlist, isCreditBroken } = await this.lockOwnedPlaylist(
        manager,
        userId,
        playlistId,
        { shouldCheckCredit: true },
      );
      // A persona credit that stopped standing is stored as what it already
      // reads as: private, under the member. An explicit choice in this same
      // edit then applies on top.
      if (isCreditBroken) {
        playlist.creditSubprofileId = null;
        playlist.isCreditedToPersona = false;
        playlist.visibility = StudioPlaylistVisibility.Private;
      }
      if (body.name !== undefined) {
        playlist.name = body.name;
      }
      if (body.description !== undefined) {
        playlist.description = toStoredDescription(body.description);
      }
      if (body.visibility !== undefined) {
        playlist.visibility = body.visibility;
      }
      if (creditSubprofileId !== undefined) {
        playlist.creditSubprofileId = creditSubprofileId;
        playlist.isCreditedToPersona = creditSubprofileId !== null;
      }
      await manager.save(playlist);
    });
    return this.playlistReads.getPlaylist(userId, playlistId);
  }

  /** Entries go with it (foreign key cascade). */
  async remove(userId: string, playlistId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockOwnedPlaylist(manager, userId, playlistId);
      await manager.delete(StudioPlaylist, { id: playlistId });
    });
  }

  async addTracks(
    userId: string,
    playlistId: string,
    body: AddStudioPlaylistTracksDto,
  ): Promise<StudioPlaylistResponse> {
    // Lowercase so a repeat or a present track matches whatever its case.
    const requestedTrackIds = [
      ...new Set(body.trackIds.map((trackId) => trackId.toLowerCase())),
    ];
    // Read before the lock, so the playlist row is held only for the write.
    const playableTrackIds = await this.playlistReads.playableTrackIds(
      userId,
      requestedTrackIds,
    );
    // The lock order below matches a persona delete or unlink. Should
    // Postgres still pick this add as a deadlock victim (40P01), the whole
    // transaction runs once more, reading everything again under fresh locks.
    await this.transactionRetryingDeadlockOnce(async (manager) => {
      await this.lockOwnedPlaylist(manager, userId, playlistId);
      const existingEntries = await manager.find(StudioPlaylistTrack, {
        where: { playlistId },
        select: { id: true, trackId: true },
      });
      const presentTrackIds = new Set(
        existingEntries.flatMap((entry) =>
          entry.trackId ? [entry.trackId] : [],
        ),
      );
      const newTrackIds = requestedTrackIds.filter(
        (trackId) => !presentTrackIds.has(trackId),
      );
      if (!newTrackIds.length) {
        return;
      }
      if (newTrackIds.some((trackId) => !playableTrackIds.has(trackId))) {
        throw studioError('studio_playlist_track_unavailable');
      }
      if (
        existingEntries.length + newTrackIds.length >
        STUDIO_LIMITS.tracksPerPlaylist
      ) {
        throw studioError('studio_playlist_track_limit');
      }
      const lockedTracks: { id: string }[] = await manager.query(
        LOCK_ADDED_TRACKS_SQL,
        [newTrackIds],
      );
      if (lockedTracks.length < newTrackIds.length) {
        throw studioError('studio_playlist_track_unavailable');
      }
      await manager.query(RENUMBER_PLAYLIST_ENTRIES_SQL, [playlistId]);
      await manager.query(APPEND_PLAYLIST_ENTRIES_SQL, [
        playlistId,
        newTrackIds,
        existingEntries.length,
      ]);
      await manager.query(TOUCH_PLAYLIST_SQL, [playlistId]);
    });
    return this.playlistReads.getPlaylist(userId, playlistId);
  }

  async removeEntry(
    userId: string,
    playlistId: string,
    entryId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockOwnedPlaylist(manager, userId, playlistId);
      const result = await manager.delete(StudioPlaylistTrack, {
        id: entryId,
        playlistId,
      });
      if (!result.affected) {
        throw new NotFoundException('Entry not found');
      }
      await manager.query(RENUMBER_PLAYLIST_ENTRIES_SQL, [playlistId]);
      await manager.query(TOUCH_PLAYLIST_SQL, [playlistId]);
    });
  }

  async reorder(
    userId: string,
    playlistId: string,
    body: ReorderStudioPlaylistEntriesDto,
  ): Promise<StudioPlaylistResponse> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockOwnedPlaylist(manager, userId, playlistId);
      const currentEntries = await manager.find(StudioPlaylistTrack, {
        where: { playlistId },
        select: { id: true },
      });
      if (
        !isSameTrackSet(
          currentEntries.map((entry) => entry.id),
          body.entryIds,
        )
      ) {
        throw studioError('studio_playlist_order_mismatch');
      }
      await manager.query(REORDER_PLAYLIST_ENTRIES_SQL, [
        playlistId,
        body.entryIds,
        body.entryIds.map((_entryId, index) => index + 1),
      ]);
      await manager.query(TOUCH_PLAYLIST_SQL, [playlistId]);
    });
    return this.playlistReads.getPlaylist(userId, playlistId);
  }

  private async transactionRetryingDeadlockOnce(
    work: (manager: EntityManager) => Promise<void>,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(work);
    } catch (error) {
      if (!isDeadlockError(error)) {
        throw error;
      }
      await this.dataSource.transaction(work);
    }
  }

  // The playlist row locked for this write, and whether its persona credit
  // stopped standing (read only when `shouldCheckCredit`, since only an edit
  // stores that state). Anyone but the owner, and a missing row, get 404.
  private async lockOwnedPlaylist(
    manager: EntityManager,
    userId: string,
    playlistId: string,
    { shouldCheckCredit = false }: { shouldCheckCredit?: boolean } = {},
  ): Promise<{ playlist: StudioPlaylist; isCreditBroken: boolean }> {
    const playlist = await manager.findOne(StudioPlaylist, {
      where: { id: playlistId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!playlist || playlist.userId !== userId) {
      throw new NotFoundException('Playlist not found');
    }
    if (!shouldCheckCredit || !playlist.isCreditedToPersona) {
      return { playlist, isCreditBroken: false };
    }
    const rows: { is_standing: boolean }[] = await manager.query(
      `SELECT ${personaCreditActiveSql('playlist')} AS "is_standing"
         FROM "studio_playlists" "playlist"
        WHERE "playlist"."id" = $1`,
      [playlistId],
    );
    return { playlist, isCreditBroken: rows[0]?.is_standing !== true };
  }

  // Takes the key share on the persona (before any playlist lock), then
  // checks it under that lock. "Show as" offers the caller's uploadable
  // personas (`GET /studio/me`), so the credit check is that same list.
  // `subprofileId` arrives lowercased.
  private async lockAllowedCredit(
    manager: EntityManager,
    userId: string,
    subprofileId: string,
  ): Promise<void> {
    const lockedPersonas: { id: string }[] = await manager.query(
      LOCK_CREDIT_PERSONA_SQL,
      [subprofileId],
    );
    if (!lockedPersonas.length) {
      throw studioError('studio_playlist_credit_not_allowed');
    }
    // On this transaction's connection: the key share above is held here, and
    // a read on a second pool connection would hold two at once.
    const personas = await this.ownership.listUploadablePersonas(
      userId,
      manager,
    );
    if (
      !personas.some((persona) => persona.id.toLowerCase() === subprofileId)
    ) {
      throw studioError('studio_playlist_credit_not_allowed');
    }
  }
}
