import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  ObjectLiteral,
  SelectQueryBuilder,
} from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import {
  CreateStudioPlaylistFolderDto,
  UpdateStudioPlaylistFolderDto,
} from './dto/studio-playlist-folder.dto';
import { StudioPlaylistFolderItem } from './entities/studio-playlist-folder-item.entity';
import { StudioPlaylistFolder } from './entities/studio-playlist-folder.entity';
import { StudioPlaylist } from './entities/studio-playlist.entity';
import {
  STUDIO_PLAYLIST_FOLDER_LIMITS,
  studioPlaylistFolderError,
} from './studio-playlist-folder.errors';
import {
  StudioPlaylistFolderResponse,
  StudioPlaylistFoldersResponse,
  toStudioPlaylistFolderResponse,
} from './studio-playlist-folder-response';
import {
  creditPersonaCreatorIdSql,
  creditStandsSql,
  personaCreatorBlockExemptSql,
  playlistOpenToViewerSql,
  playlistOwnerIsActiveSql,
  viewerEditsPlaylistSql,
} from './studio-playlist-visibility';

/** The parameter every fileable read binds to the caller. */
export const FOLDER_VIEWER_PARAMETER = 'folderViewerId';

/**
 * True when the member may file `"playlist"` in a folder. The playlist must
 * be open to them by link (`playlistOpenToViewerSql`, the rule the playlist
 * page and saved availability apply), and they must own it, hold an
 * `active` editor seat while its credit stands and its owner's account is
 * active (the editor reads' rule), or have saved it. A save alone never
 * qualifies: a saved playlist that went private, or a saved uuid that names
 * nothing open to them, reads as unavailable. Blocks are added by
 * `applyFileableFilter`.
 */
export const PLAYLIST_FILEABLE_BY_MEMBER_SQL = `(${playlistOpenToViewerSql('playlist', FOLDER_VIEWER_PARAMETER)}
   AND (
     "playlist"."user_id" = :${FOLDER_VIEWER_PARAMETER}
     OR (${viewerEditsPlaylistSql('playlist', FOLDER_VIEWER_PARAMETER)}
       AND ${creditStandsSql('playlist')}
       AND ${playlistOwnerIsActiveSql('playlist')})
     OR EXISTS (
       SELECT 1 FROM "saved_item" "folder_saved"
        WHERE "folder_saved"."user_id" = :${FOLDER_VIEWER_PARAMETER}
          AND "folder_saved"."subject_type" = 'studio_playlist'
          AND "folder_saved"."subject_id" = "playlist"."id"::text
     )
   ))`;

/** `$1` the member, `$2` the playlist, `$3` the folder. One row per member
 *  and playlist: filing it again moves it. */
export const FILE_PLAYLIST_SQL = `INSERT INTO "studio_playlist_folder_items" ("folder_id", "user_id", "playlist_id")
VALUES ($3, $1, $2)
ON CONFLICT ON CONSTRAINT "UQ_studio_playlist_folder_items_user_playlist"
DO UPDATE SET "folder_id" = EXCLUDED."folder_id", "created_at" = now()`;

export const UNFILE_PLAYLIST_SQL = `DELETE FROM "studio_playlist_folder_items" WHERE "user_id" = $1 AND "playlist_id" = $2`;

/** Serialises one member's folder writes, so the count under the cap and
 *  the next position are read and written as one step. */
export const LOCK_MEMBER_FOLDERS_SQL = `SELECT pg_advisory_xact_lock(hashtext('studio_playlist_folders:' || $1::text))`;

/** `$1` the folder ids in their new order: positions 0..n-1. */
export const RENUMBER_FOLDERS_SQL = `UPDATE "studio_playlist_folders" AS "folder"
   SET "position" = ("ordering"."ordinal" - 1)::int
  FROM unnest($1::uuid[]) WITH ORDINALITY AS "ordering"("folder_id", "ordinal")
 WHERE "folder"."id" = "ordering"."folder_id"
   AND "folder"."position" <> ("ordering"."ordinal" - 1)::int`;

interface FiledPlaylistRow {
  folder_id: string;
  playlist_id: string;
}

/** Folder writes that file a playlist: the playlist, then the folder. */
interface FilePlaylistTarget {
  playlistId: string;
  folderId: string;
}

/**
 * Playlist folders: a member's own way to group the playlists in their rail
 * and Library. Everything here is private to the caller. Nothing about
 * listening is read or written; a folder holds playlist ids only.
 */
@Injectable()
export class StudioPlaylistFoldersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
  ) {}

  async list(userId: string): Promise<StudioPlaylistFoldersResponse> {
    const manager = this.dataSource.manager;
    const folders = await this.foldersOf(manager, userId);
    const filed = await this.filedPlaylistIds(manager, userId);
    return {
      items: folders.map((folder) =>
        toStudioPlaylistFolderResponse(folder, filed.get(folder.id) ?? []),
      ),
    };
  }

  async create(
    userId: string,
    body: CreateStudioPlaylistFolderDto,
  ): Promise<StudioPlaylistFolderResponse> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_MEMBER_FOLDERS_SQL, [userId]);
      const folders = await this.foldersOf(manager, userId);
      if (folders.length >= STUDIO_PLAYLIST_FOLDER_LIMITS.foldersPerMember) {
        throw studioPlaylistFolderError('studio_playlist_folder_limit');
      }
      const lastPosition = folders.reduce(
        (highest, folder) => Math.max(highest, folder.position),
        -1,
      );
      const folder = await manager.save(
        manager.create(StudioPlaylistFolder, {
          userId,
          name: body.name,
          position: lastPosition + 1,
        }),
      );
      if (!body.playlistId) {
        return toStudioPlaylistFolderResponse(folder, []);
      }
      // "Move to new folder": a playlist that cannot be filed rolls the new
      // folder back with it, so a refusal never leaves an empty folder.
      await this.filePlaylist(manager, userId, {
        playlistId: body.playlistId,
        folderId: folder.id,
      });
      return toStudioPlaylistFolderResponse(folder, [body.playlistId]);
    });
  }

  /** Rename, move among the member's folders, or both. */
  async update(
    userId: string,
    folderId: string,
    body: UpdateStudioPlaylistFolderDto,
  ): Promise<StudioPlaylistFolderResponse> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_MEMBER_FOLDERS_SQL, [userId]);
      const folders = await this.foldersOf(manager, userId);
      const folder = folders.find((candidate) => candidate.id === folderId);
      if (!folder) {
        throw studioPlaylistFolderError('studio_playlist_folder_not_found');
      }
      if (body.name !== undefined && body.name !== folder.name) {
        folder.name = body.name;
        await manager.update(
          StudioPlaylistFolder,
          { id: folder.id },
          { name: body.name },
        );
      }
      if (body.position !== undefined) {
        const others = folders.filter((candidate) => candidate !== folder);
        const index = Math.min(body.position, others.length);
        const ordered = [
          ...others.slice(0, index),
          folder,
          ...others.slice(index),
        ];
        await manager.query(RENUMBER_FOLDERS_SQL, [
          ordered.map((candidate) => candidate.id),
        ]);
        folder.position = index;
      }
      const filed = await this.filedPlaylistIds(manager, userId);
      return toStudioPlaylistFolderResponse(folder, filed.get(folder.id) ?? []);
    });
  }

  /** Deletes the folder; its playlists go back to the top level (the
   *  items cascade). The playlists themselves are untouched. */
  async remove(userId: string, folderId: string): Promise<void> {
    const result = await this.dataSource.manager.delete(StudioPlaylistFolder, {
      id: folderId,
      userId,
    });
    if (!result.affected) {
      throw studioPlaylistFolderError('studio_playlist_folder_not_found');
    }
  }

  /** Files the playlist in one of the caller's folders, moving it out of
   *  any other, or with `folderId: null` puts it back at the top level.
   *  Unfiling needs no check: it only ever deletes the caller's own row. */
  async movePlaylist(
    userId: string,
    playlistId: string,
    folderId: string | null,
  ): Promise<void> {
    if (folderId === null) {
      await this.dataSource.manager.query(UNFILE_PLAYLIST_SQL, [
        userId,
        playlistId,
      ]);
      return;
    }
    await this.dataSource.transaction(async (manager) => {
      const folder = await manager.findOne(StudioPlaylistFolder, {
        where: { id: folderId, userId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!folder) {
        throw studioPlaylistFolderError('studio_playlist_folder_not_found');
      }
      await this.filePlaylist(manager, userId, { playlistId, folderId });
    });
  }

  /** Files one playlist the caller may file, else 404 with the same code
   *  whether the playlist is missing, closed to them or never theirs. */
  private async filePlaylist(
    manager: EntityManager,
    userId: string,
    target: FilePlaylistTarget,
  ): Promise<void> {
    const queryBuilder = manager
      .createQueryBuilder(StudioPlaylist, 'playlist')
      .select('playlist.id', 'id')
      .where('playlist.id = :folderPlaylistId', {
        folderPlaylistId: target.playlistId,
      });
    this.applyFileableFilter(queryBuilder, userId);
    const fileable: unknown = await queryBuilder.getRawOne();
    if (!fileable) {
      throw studioPlaylistFolderError(
        'studio_playlist_folder_playlist_unavailable',
      );
    }
    await manager.query(FILE_PLAYLIST_SQL, [
      userId,
      target.playlistId,
      target.folderId,
    ]);
  }

  /** `PLAYLIST_FILEABLE_BY_MEMBER_SQL`, then blocks either way on the owner
   *  and, for a persona credit, on the member who created the persona, as
   *  `SavedAvailabilityService.resolveStudioPlaylists` applies them. */
  private applyFileableFilter<Entity extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<Entity>,
    userId: string,
  ): void {
    queryBuilder.andWhere(PLAYLIST_FILEABLE_BY_MEMBER_SQL, {
      [FOLDER_VIEWER_PARAMETER]: userId,
    });
    this.blockFilter.excludeBlocked(
      queryBuilder,
      userId,
      '"playlist"."user_id"',
    );
    // Binds `blockFilterActorId` to the same caller as the call above.
    this.blockFilter.excludeBlocked(
      queryBuilder,
      userId,
      creditPersonaCreatorIdSql('playlist'),
      {
        unless: personaCreatorBlockExemptSql(
          'playlist',
          FOLDER_VIEWER_PARAMETER,
        ),
      },
    );
  }

  private foldersOf(
    manager: EntityManager,
    userId: string,
  ): Promise<StudioPlaylistFolder[]> {
    return manager.find(StudioPlaylistFolder, {
      where: { userId },
      order: { position: 'ASC', id: 'ASC' },
    });
  }

  /** Every playlist the caller filed that they may still file, with its
   *  folder, earliest filed first. */
  private async filedPlaylistIds(
    manager: EntityManager,
    userId: string,
  ): Promise<Map<string, string[]>> {
    const queryBuilder = manager
      .createQueryBuilder(StudioPlaylistFolderItem, 'item')
      .innerJoin(StudioPlaylist, 'playlist', 'playlist.id = item.playlistId')
      .select('item.folderId', 'folder_id')
      .addSelect('item.playlistId', 'playlist_id')
      .where('item.userId = :folderItemUserId', { folderItemUserId: userId })
      .orderBy('item.createdAt', 'ASC')
      .addOrderBy('item.id', 'ASC');
    this.applyFileableFilter(queryBuilder, userId);
    const rows = await queryBuilder.getRawMany<FiledPlaylistRow>();
    const byFolder = new Map<string, string[]>();
    for (const row of rows) {
      const playlistIds = byFolder.get(row.folder_id) ?? [];
      playlistIds.push(row.playlist_id);
      byFolder.set(row.folder_id, playlistIds);
    }
    return byFolder;
  }
}
