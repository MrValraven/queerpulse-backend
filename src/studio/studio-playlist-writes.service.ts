import { Injectable } from '@nestjs/common';
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
import { endEditorsOnPlaylist } from './studio-playlist-editor-endings';
import {
  StudioPlaylistRoleRefusal,
  StudioPlaylistWriteRole,
  lockPlaylistFor,
  playlistRoleRefusal,
} from './studio-playlist-roles';
import { personaCreditActiveSql } from './studio-playlist-visibility';
import { isSameTrackSet } from './studio-tracks.service';
import {
  STUDIO_LIMITS,
  studioError,
  studioErrorWithDetails,
} from './studio.constants';

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

/** Appends `$2` in order after the `$3` entries already there, recording
 *  `$4` (the owner or the editor who added them) as `added_by_user_id`. */
export const APPEND_PLAYLIST_ENTRIES_SQL = `INSERT INTO "studio_playlist_tracks" ("playlist_id", "track_id", "position", "added_by_user_id")
SELECT $1::uuid, "added"."track_id", ($3::int + "added"."ordinal")::smallint, $4::uuid
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

/** The owner of a playlist, read without a lock: an owner-only edit
 *  refuses an editor before the persona key share, so the lock order of a
 *  credit change stays persona first, playlist second. */
export const READ_PLAYLIST_OWNER_SQL = `SELECT "user_id" FROM "studio_playlists" WHERE "id" = $1`;

/** `$1` the playlist, `$2` the new persona credit (null for the member).
 *  The live editors whose source does not fit that credit: a member credit
 *  takes invited connections, a persona credit takes co-owners of that
 *  persona, so a persona to persona change keeps co-owners of both. */
export const EDITORS_UNFIT_FOR_CREDIT_SQL = `SELECT "editor"."user_id" AS "user_id"
  FROM "studio_playlist_editors" "editor"
 WHERE "editor"."playlist_id" = $1
   AND "editor"."status" IN ('invited', 'active')
   AND (
     ($2::uuid IS NULL AND "editor"."source" = 'persona_co_owner')
     OR ($2::uuid IS NOT NULL AND (
       "editor"."source" = 'member_invite'
       OR NOT EXISTS (
         SELECT 1 FROM "subprofile_members" "new_credit_member"
          WHERE "new_credit_member"."subprofile_id" = $2::uuid
            AND "new_credit_member"."user_id" = "editor"."user_id"
       )
     ))
   )
 ORDER BY "editor"."invited_at" ASC, "editor"."id" ASC`;

/** Thrown inside the update transaction when a credit change would end
 *  editors and the owner did not confirm it; mapped to the 409 with their
 *  names once the transaction has rolled back. */
class StudioPlaylistCreditChangeRefusal extends Error {
  constructor(readonly userIds: string[]) {
    super('A credit change would remove editors');
    this.name = 'StudioPlaylistCreditChangeRefusal';
  }
}

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
 * Studio v2 playlist writes, collaborative since 2026-10-14. Every write
 * locks the playlist row through `lockPlaylistFor`: track adds, removals,
 * reorders, renames and description edits admit the owner and active
 * editors; visibility, credit and delete admit the owner. A caller without
 * the role gets 404 when they cannot open the playlist and 403
 * `studio_playlist_owner_only` when they can. Each write answers with the
 * caller's own view.
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
    const isOwnerOnlyEdit =
      body.visibility !== undefined || creditSubprofileId !== undefined;
    const required: StudioPlaylistWriteRole = isOwnerOnlyEdit
      ? 'owner'
      : 'editor';
    await this.withPlaylistRole(userId, playlistId, () =>
      this.dataSource.transaction(async (manager) => {
        if (isOwnerOnlyEdit) {
          await this.assertOwnerBeforeCreditLock(manager, userId, playlistId);
        }
        if (creditSubprofileId) {
          await this.lockAllowedCredit(manager, userId, creditSubprofileId);
        }
        const { playlist, role } = await lockPlaylistFor(
          manager,
          playlistId,
          userId,
          required,
        );
        // A persona credit that stopped standing is stored as what it
        // already reads as: private, under the member. The co-owner editors
        // it carried end with it at once, since the credit they fit is
        // already gone. An explicit choice in this same edit then applies on
        // top. The owner alone reaches this: an editor of a playlist whose
        // credit stopped standing holds no role, so `lockPlaylistFor` has
        // refused them above, and the role check keeps an editor's rename
        // from ever clearing a credit.
        if (
          role === 'owner' &&
          (await this.isCreditBrokenUnderLock(manager, playlist))
        ) {
          playlist.creditSubprofileId = null;
          playlist.isCreditedToPersona = false;
          playlist.visibility = StudioPlaylistVisibility.Private;
          await endEditorsOnPlaylist(
            manager,
            playlistId,
            await this.editorsUnfitFor(manager, playlistId, null),
            'revoked',
          );
        }
        const currentCreditSubprofileId = playlist.isCreditedToPersona
          ? playlist.creditSubprofileId
          : null;
        if (
          creditSubprofileId !== undefined &&
          creditSubprofileId !== currentCreditSubprofileId
        ) {
          const unfitUserIds = await this.editorsUnfitFor(
            manager,
            playlistId,
            creditSubprofileId,
          );
          if (unfitUserIds.length && body.confirmEditorRemoval !== true) {
            throw new StudioPlaylistCreditChangeRefusal(unfitUserIds);
          }
          await endEditorsOnPlaylist(
            manager,
            playlistId,
            unfitUserIds,
            'revoked',
          );
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
      }),
    );
    return this.playlistReads.getPlaylist(userId, playlistId);
  }

  /** Entries and editor rows go with it (foreign key cascade). */
  async remove(userId: string, playlistId: string): Promise<void> {
    await this.withPlaylistRole(userId, playlistId, () =>
      this.dataSource.transaction(async (manager) => {
        await lockPlaylistFor(manager, playlistId, userId, 'owner');
        await manager.delete(StudioPlaylist, { id: playlistId });
      }),
    );
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
    // The caller's own view decides playability, owner or editor alike.
    const playableTrackIds = await this.playlistReads.playableTrackIds(
      userId,
      requestedTrackIds,
    );
    // The lock order below matches a persona delete or unlink. Should
    // Postgres still pick this add as a deadlock victim (40P01), the whole
    // transaction runs once more, reading everything again under fresh locks.
    // Two editors adding at once queue on the playlist row lock; the unique
    // `(playlist_id, track_id)` keeps a track from landing twice.
    await this.withPlaylistRole(userId, playlistId, () =>
      this.transactionRetryingDeadlockOnce(async (manager) => {
        await lockPlaylistFor(manager, playlistId, userId, 'editor');
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
          userId,
        ]);
        await manager.query(TOUCH_PLAYLIST_SQL, [playlistId]);
      }),
    );
    return this.playlistReads.getPlaylist(userId, playlistId);
  }

  async removeEntry(
    userId: string,
    playlistId: string,
    entryId: string,
  ): Promise<void> {
    await this.withPlaylistRole(userId, playlistId, () =>
      this.dataSource.transaction(async (manager) => {
        await lockPlaylistFor(manager, playlistId, userId, 'editor');
        const result = await manager.delete(StudioPlaylistTrack, {
          id: entryId,
          playlistId,
        });
        // Another editor may have removed it first; the client refetches.
        if (!result.affected) {
          throw studioError('studio_playlist_entry_not_found');
        }
        await manager.query(RENUMBER_PLAYLIST_ENTRIES_SQL, [playlistId]);
        await manager.query(TOUCH_PLAYLIST_SQL, [playlistId]);
      }),
    );
  }

  async reorder(
    userId: string,
    playlistId: string,
    body: ReorderStudioPlaylistEntriesDto,
  ): Promise<StudioPlaylistResponse> {
    await this.withPlaylistRole(userId, playlistId, () =>
      this.dataSource.transaction(async (manager) => {
        await lockPlaylistFor(manager, playlistId, userId, 'editor');
        const currentEntries = await manager.find(StudioPlaylistTrack, {
          where: { playlistId },
          select: { id: true },
        });
        // A list another editor made stale answers the mismatch; the client
        // refetches and asks to try again.
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
      }),
    );
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

  // Runs a write and turns the two refusals that need reads into HTTP
  // answers once its transaction has rolled back: the role refusal (403 or
  // 404, asked of the reads service) and the unconfirmed credit change (409
  // with the editors' names).
  private async withPlaylistRole<Result>(
    userId: string,
    playlistId: string,
    run: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof StudioPlaylistRoleRefusal) {
        throw await playlistRoleRefusal(() =>
          this.playlistReads.isOpenToViewer(userId, playlistId),
        );
      }
      if (error instanceof StudioPlaylistCreditChangeRefusal) {
        const people = await this.playlistReads.peopleByUserIds(error.userIds);
        throw studioErrorWithDetails(
          'studio_playlist_credit_change_removes_editors',
          {
            // Members who are no longer active accounts are not returned
            // by the reads service and drop out of the names; the removal
            // still ends every unfit editor.
            editors: error.userIds.flatMap((editorUserId) => {
              const person = people.get(editorUserId);
              return person ? [person] : [];
            }),
          },
        );
      }
      throw error;
    }
  }

  // An owner-only edit (visibility, credit) refuses anyone but the owner
  // before the persona key share, reading the owner without a lock so the
  // credit change keeps its lock order. A missing playlist answers 404.
  private async assertOwnerBeforeCreditLock(
    manager: EntityManager,
    userId: string,
    playlistId: string,
  ): Promise<void> {
    const rows: { user_id: string }[] = await manager.query(
      READ_PLAYLIST_OWNER_SQL,
      [playlistId],
    );
    const ownerRow = rows[0];
    if (!ownerRow) {
      throw studioError('studio_playlist_not_found');
    }
    if (ownerRow.user_id !== userId) {
      throw new StudioPlaylistRoleRefusal();
    }
  }

  // Whether the playlist's persona credit stopped standing, read under the
  // playlist lock. Only an owner's edit stores that state.
  private async isCreditBrokenUnderLock(
    manager: EntityManager,
    playlist: StudioPlaylist,
  ): Promise<boolean> {
    if (!playlist.isCreditedToPersona) {
      return false;
    }
    const rows: { is_standing: boolean }[] = await manager.query(
      `SELECT ${personaCreditActiveSql('playlist')} AS "is_standing"
         FROM "studio_playlists" "playlist"
        WHERE "playlist"."id" = $1`,
      [playlist.id],
    );
    return rows[0]?.is_standing !== true;
  }

  private async editorsUnfitFor(
    manager: EntityManager,
    playlistId: string,
    creditSubprofileId: string | null,
  ): Promise<string[]> {
    const rows: { user_id: string }[] = await manager.query(
      EDITORS_UNFIT_FOR_CREDIT_SQL,
      [playlistId, creditSubprofileId],
    );
    return rows.map((row) => row.user_id);
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
