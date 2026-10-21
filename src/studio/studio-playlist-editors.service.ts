import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { foldedHaystack, foldedTextExpression } from '../search/search-text';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { AddStudioPlaylistEditorsDto } from './dto/add-studio-playlist-editors.dto';
import { StudioPlaylistInviteResponse } from './dto/respond-studio-playlist-editor-invite.dto';
import {
  LIVE_STUDIO_PLAYLIST_EDITOR_STATUSES,
  StudioPlaylistEditor,
  StudioPlaylistEditorSource,
  StudioPlaylistEditorStatus,
} from './entities/studio-playlist-editor.entity';
import { StudioPlaylist } from './entities/studio-playlist.entity';
import { endEditorsOnPlaylist } from './studio-playlist-editor-endings';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import {
  StudioPlaylistEditorCandidateList,
  StudioPlaylistEditorIneligibleReason,
  StudioPlaylistEditorList,
  StudioPlaylistIneligibleMember,
  StudioPlaylistResponse,
  toStudioPlaylistEditorResponse,
  toStudioPlaylistPerson,
} from './studio-playlist-response';
import {
  StudioPlaylistRoleRefusal,
  isPlaylistCreditStanding,
  lockPlaylistFor,
  playlistRoleRefusal,
} from './studio-playlist-roles';
import { playlistOwnerIsActiveSql } from './studio-playlist-visibility';
import { isDeadlockError } from './studio-playlist-writes.service';
import {
  STUDIO_LIMITS,
  studioError,
  studioErrorWithDetails,
} from './studio.constants';

/** `$1` an editor row, `$2` the playlist: the row's member, only when the
 *  row belongs to that playlist. Read under the playlist row lock. */
export const EDITOR_ROW_ON_PLAYLIST_SQL = `SELECT "editor"."user_id" AS "user_id"
  FROM "studio_playlist_editors" "editor"
 WHERE "editor"."id" = $1
   AND "editor"."playlist_id" = $2`;

/** `$1` the playlist: the members holding an `invited` or `active` row.
 *  Read under the playlist row lock, so two invites cannot both pass the
 *  cap. */
export const LIVE_EDITOR_USER_IDS_SQL = `SELECT "editor"."user_id" AS "user_id"
  FROM "studio_playlist_editors" "editor"
 WHERE "editor"."playlist_id" = $1
   AND "editor"."status" IN ('invited', 'active')`;

/** `$1` the credit persona, `$2` the picked members and the owner
 *  (uuid[]): their roster rows on the persona, held `FOR KEY SHARE` so no
 *  co-owner (the owner included) leaves the persona between the credit
 *  check, the facts read and the pick. */
export const LOCK_PICKED_CO_OWNER_ROWS_SQL = `SELECT "member"."user_id" AS "user_id"
  FROM "subprofile_members" "member"
 WHERE "member"."subprofile_id" = $1
   AND "member"."user_id" = ANY($2::uuid[])
   FOR KEY SHARE OF "member"`;

/** `$1` the members (uuid[]), `$2` the owner, `$3` the credit persona or
 *  null. One row per member that exists: connection with the owner, block
 *  either way, Studio grant, co-ownership of the persona. */
export const EDITOR_FACTS_SQL = `SELECT "target"."user_id" AS "user_id",
       EXISTS (
         SELECT 1 FROM "connections" "owner_connection"
          WHERE "owner_connection"."status" = 'accepted'
            AND (("owner_connection"."requester_id" = $2
                  AND "owner_connection"."addressee_id" = "target"."user_id")
              OR ("owner_connection"."addressee_id" = $2
                  AND "owner_connection"."requester_id" = "target"."user_id"))
       ) AS "is_connected",
       EXISTS (
         SELECT 1 FROM "blocks" "owner_block"
          WHERE ("owner_block"."blocker_id" = $2
                 AND "owner_block"."blocked_id" = "target"."user_id")
             OR ("owner_block"."blocker_id" = "target"."user_id"
                 AND "owner_block"."blocked_id" = $2)
       ) AS "is_blocked",
       EXISTS (
         SELECT 1 FROM "studio_access_grants" "target_grant"
          WHERE "target_grant"."user_id" = "target"."user_id"
       ) AS "has_studio_access",
       EXISTS (
         SELECT 1 FROM "subprofile_members" "credit_member"
          WHERE "credit_member"."subprofile_id" = $3::uuid
            AND "credit_member"."user_id" = "target"."user_id"
       ) AS "is_co_owner"
  FROM unnest($1::uuid[]) AS "target"("user_id")`;

/** `$1` the playlist, `$2` the members (uuid[]), `$3` the owner, `$4` the
 *  source, `$5` the status, `$6` whether the seat is accepted now (a
 *  persona pick). A member whose seat ended reuses the row with fresh
 *  timestamps; a live row is left alone. */
export const UPSERT_EDITORS_SQL = `INSERT INTO "studio_playlist_editors"
       ("playlist_id", "user_id", "invited_by_user_id", "source", "status", "invited_at", "accepted_at", "ended_at")
SELECT $1::uuid, "added"."user_id", $3::uuid,
       $4::"studio_playlist_editors_source_enum",
       $5::"studio_playlist_editors_status_enum",
       now(),
       CASE WHEN $6::boolean THEN now() END,
       NULL
  FROM unnest($2::uuid[]) AS "added"("user_id")
ON CONFLICT ("playlist_id", "user_id") DO UPDATE
   SET "invited_by_user_id" = EXCLUDED."invited_by_user_id",
       "source" = EXCLUDED."source",
       "status" = EXCLUDED."status",
       "invited_at" = EXCLUDED."invited_at",
       "accepted_at" = EXCLUDED."accepted_at",
       "ended_at" = NULL
 WHERE "studio_playlist_editors"."status" NOT IN ('invited', 'active')`;

/** `$1` the playlist, `$2` the invitee: their open invitation, locked. */
export const LOCK_INVITED_ROW_SQL = `SELECT "editor"."id" AS "id", "editor"."source"::text AS "source"
  FROM "studio_playlist_editors" "editor"
 WHERE "editor"."playlist_id" = $1
   AND "editor"."user_id" = $2
   AND "editor"."status" = 'invited'
   FOR UPDATE OF "editor"`;

/** `$1` the playlist: whether its owner is an active account. An owner who
 *  is paused, pending deletion or suspended closes the playlist to its
 *  invitees, so their accept answers 404. */
export const PLAYLIST_OWNER_ACTIVE_SQL = `SELECT ${playlistOwnerIsActiveSql('playlist')} AS "is_owner_active"
  FROM "studio_playlists" "playlist"
 WHERE "playlist"."id" = $1`;

/** `$1` the row, `$2` the new status, `$3` whether it is the accept. An
 *  invitation has no entries to clear. */
export const ANSWER_INVITE_SQL = `UPDATE "studio_playlist_editors"
   SET "status" = $2::"studio_playlist_editors_status_enum",
       "accepted_at" = CASE WHEN $3::boolean THEN now() END,
       "ended_at" = CASE WHEN $3::boolean THEN NULL ELSE now() END
 WHERE "id" = $1`;

/** `$1` the credit persona, `$2` the owner, `$3` the playlist, `$4` a LIKE
 *  pattern or null, `$5` the limit. Co-owners with an active account and a
 *  Studio grant, minus the owner and anyone blocked either way with them. */
export const EDITOR_CANDIDATES_SQL = `SELECT "member"."user_id" AS "user_id",
       EXISTS (
         SELECT 1 FROM "studio_playlist_editors" "candidate_editor"
          WHERE "candidate_editor"."playlist_id" = $3
            AND "candidate_editor"."user_id" = "member"."user_id"
            AND "candidate_editor"."status" = 'active'
       ) AS "is_editor"
  FROM "subprofile_members" "member"
 INNER JOIN "users" "candidate_user"
    ON "candidate_user"."id" = "member"."user_id"
   AND "candidate_user"."status" = '${UserStatus.Active}'
 INNER JOIN "profiles" "candidate_profile"
    ON "candidate_profile"."user_id" = "member"."user_id"
 WHERE "member"."subprofile_id" = $1
   AND "member"."user_id" <> $2
   AND EXISTS (
     SELECT 1 FROM "studio_access_grants" "candidate_grant"
      WHERE "candidate_grant"."user_id" = "member"."user_id"
   )
   AND NOT EXISTS (
     SELECT 1 FROM "blocks" "candidate_block"
      WHERE ("candidate_block"."blocker_id" = $2
             AND "candidate_block"."blocked_id" = "member"."user_id")
         OR ("candidate_block"."blocker_id" = "member"."user_id"
             AND "candidate_block"."blocked_id" = $2)
   )
   AND ($4::text IS NULL
     OR ${foldedHaystack('candidate_profile', ['first_name', 'last_name', 'slug'])} LIKE ${foldedTextExpression('$4::text')} ESCAPE '\\')
 ORDER BY "candidate_profile"."first_name" ASC,
          "candidate_profile"."last_name" ASC,
          "member"."user_id" ASC
 LIMIT $5`;

/** `$1` a persona: its display name, the handle when the name is blank. */
export const PERSONA_NAME_SQL = `SELECT COALESCE(NULLIF(btrim("persona"."display_name"), ''), "persona"."handle") AS "persona_name"
  FROM "subprofiles" "persona"
 WHERE "persona"."id" = $1`;

interface EditorFactsRow {
  user_id: string;
  is_connected: boolean;
  is_blocked: boolean;
  has_studio_access: boolean;
  is_co_owner: boolean;
}

interface AddEditorsOutcome {
  playlist: StudioPlaylist;
  source: StudioPlaylistEditorSource;
  newUserIds: string[];
}

interface InviteAnswerOutcome {
  answer: 'accepted' | 'declined' | 'unavailable';
  playlist: StudioPlaylist;
}

/** Why a member may not edit, or null when they may. A member may edit when
 *  present, someone other than the owner, with no block either way, a
 *  Studio grant, and the fit for the source (a connection of the owner for
 *  a member credit, a co-owner of the persona for a persona credit). The
 *  checks run in that order and the first that fails is the reason. */
function ineligibilityReasonOf(
  facts: EditorFactsRow | undefined,
  userId: string | undefined,
  ownerId: string,
  source: StudioPlaylistEditorSource,
): StudioPlaylistEditorIneligibleReason | null {
  if (!userId || !facts) {
    return 'not_found';
  }
  if (userId === ownerId) {
    return 'is_owner';
  }
  if (facts.is_blocked) {
    return 'blocked';
  }
  if (!facts.has_studio_access) {
    return 'no_studio_access';
  }
  if (source === StudioPlaylistEditorSource.PersonaCoOwner) {
    return facts.is_co_owner ? null : 'not_co_owner';
  }
  return facts.is_connected ? null : 'not_connected';
}

/** The `studio_playlist_editor_ineligible` refusal: `memberSlugs` names the
 *  members and `ineligibleMembers` gives each one's reason, both in request
 *  order. */
function editorIneligibleError(
  ineligibleMembers: StudioPlaylistIneligibleMember[],
): HttpException {
  return studioErrorWithDetails('studio_playlist_editor_ineligible', {
    memberSlugs: ineligibleMembers.map((member) => member.memberSlug),
    ineligibleMembers,
  });
}

/**
 * Collaborative playlists (QUEERPULSE-STUDIO-COLLAB-PLAYLISTS-CONTRACT-2026-10-14.md):
 * the editor roster of one playlist. Owner only: invite or pick, remove,
 * list candidates. Editors: read the active roster, leave. Invitees:
 * answer. Every change runs under the playlist row lock; notifications go
 * out after commit and never fail the change. Nothing here is public.
 */
@Injectable()
export class StudioPlaylistEditorsService {
  private readonly logger = new Logger(StudioPlaylistEditorsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly playlistReads: StudioPlaylistReadsService,
    private readonly notifications: NotificationsService,
    @InjectRepository(StudioPlaylist)
    private readonly playlists: Repository<StudioPlaylist>,
    @InjectRepository(StudioPlaylistEditor)
    private readonly editors: Repository<StudioPlaylistEditor>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /** `GET :id/editors`: the owner reads invited and active rows, an active
   *  editor the active ones, each without the members blocked either way
   *  with them. */
  async listEditors(
    viewerId: string,
    playlistId: string,
  ): Promise<StudioPlaylistEditorList> {
    const playlist = await this.playlists.findOne({
      where: { id: playlistId },
    });
    if (!playlist) {
      throw studioError('studio_playlist_not_found');
    }
    const role = await this.playlistReads.viewerRole(viewerId, playlist);
    if (role !== 'owner' && role !== 'editor') {
      throw await this.refusal(viewerId, playlistId);
    }
    // An editor reads the roster only while they can open the playlist
    // (a broken persona credit closes it to everyone but the owner).
    if (
      role === 'editor' &&
      !(await this.playlistReads.isOpenToViewer(viewerId, playlistId))
    ) {
      throw studioError('studio_playlist_not_found');
    }
    return this.editorList(
      viewerId,
      playlistId,
      role === 'owner'
        ? [...LIVE_STUDIO_PLAYLIST_EDITOR_STATUSES]
        : [StudioPlaylistEditorStatus.Active],
    );
  }

  /** `POST :id/editors`: invites connections (member credit) or picks
   *  co-owners (persona credit). All or nothing. */
  async addEditors(
    ownerId: string,
    playlistId: string,
    body: AddStudioPlaylistEditorsDto,
  ): Promise<StudioPlaylistEditorList> {
    const userIdBySlug = await new MemberLookup(this.profiles).userIdsForSlugs(
      body.memberSlugs,
    );
    // A persona unlink rekeys the roster rows and then the playlist row,
    // the reverse of this lock order, so a deadlock retries once.
    const outcome = await this.withPlaylistRole(ownerId, playlistId, () =>
      this.transactionRetryingDeadlockOnce((manager) =>
        this.addEditorsUnderLock(
          manager,
          ownerId,
          playlistId,
          body.memberSlugs,
          userIdBySlug,
        ),
      ),
    );
    await this.notifyNewEditors(ownerId, outcome);
    return this.editorList(ownerId, playlistId, [
      ...LIVE_STUDIO_PLAYLIST_EDITOR_STATUSES,
    ]);
  }

  /** `DELETE :id/editors/:editorId`: revokes an editor or cancels an
   *  invite, addressed by the editor row id. The owner check comes first, so
   *  a caller who is no owner learns nothing about the id. A row that
   *  already ended is done; an id that is unknown or on another playlist
   *  answers 404 `studio_playlist_editor_not_found`. */
  async removeEditor(
    ownerId: string,
    playlistId: string,
    editorId: string,
  ): Promise<void> {
    await this.withPlaylistRole(ownerId, playlistId, () =>
      this.dataSource.transaction(async (manager) => {
        await lockPlaylistFor(manager, playlistId, ownerId, 'owner');
        const editorRows: { user_id: string }[] = await manager.query(
          EDITOR_ROW_ON_PLAYLIST_SQL,
          [editorId, playlistId],
        );
        const editorRow = editorRows[0];
        if (!editorRow) {
          throw studioError('studio_playlist_editor_not_found');
        }
        // Ends the row only while it is live, so a repeat changes nothing.
        await endEditorsOnPlaylist(
          manager,
          playlistId,
          [editorRow.user_id],
          'revoked',
        );
      }),
    );
  }

  /** `DELETE :id/editors/me`: an active editor leaves; the tracks they
   *  added stay and lose their "added by". The owner gets a no-op. */
  async leave(userId: string, playlistId: string): Promise<void> {
    await this.withPlaylistRole(userId, playlistId, () =>
      this.dataSource.transaction(async (manager) => {
        const { role } = await lockPlaylistFor(
          manager,
          playlistId,
          userId,
          'editor',
        );
        if (role === 'editor') {
          await endEditorsOnPlaylist(manager, playlistId, [userId], 'left');
        }
      }),
    );
  }

  /** `POST :id/editor-invite`. Accept answers 404 while the owner is not
   *  an active account and leaves the row as it is. Accept re-checks the
   *  connection, the block and the member credit; a failure commits the row
   *  as revoked and then answers 409. */
  async respondToInvite(
    userId: string,
    playlistId: string,
    response: StudioPlaylistInviteResponse,
  ): Promise<StudioPlaylistResponse | null> {
    const outcome = await this.dataSource.transaction(
      async (manager): Promise<InviteAnswerOutcome> => {
        const playlist = await manager.findOne(StudioPlaylist, {
          where: { id: playlistId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!playlist) {
          throw studioError('studio_playlist_invite_not_found');
        }
        const invitedRows: {
          id: string;
          source: StudioPlaylistEditorSource;
        }[] = await manager.query(LOCK_INVITED_ROW_SQL, [playlistId, userId]);
        const invitedRow = invitedRows[0];
        if (!invitedRow) {
          throw studioError('studio_playlist_invite_not_found');
        }
        if (response === 'decline') {
          await manager.query(ANSWER_INVITE_SQL, [
            invitedRow.id,
            StudioPlaylistEditorStatus.Declined,
            false,
          ]);
          return { answer: 'declined', playlist };
        }
        const ownerRows: { is_owner_active: boolean }[] = await manager.query(
          PLAYLIST_OWNER_ACTIVE_SQL,
          [playlistId],
        );
        if (ownerRows[0]?.is_owner_active !== true) {
          throw studioError('studio_playlist_invite_not_found');
        }
        const factsRows: EditorFactsRow[] = await manager.query(
          EDITOR_FACTS_SQL,
          [[userId], playlist.userId, null],
        );
        const facts = factsRows[0];
        const isStillEligible =
          !playlist.isCreditedToPersona &&
          invitedRow.source === StudioPlaylistEditorSource.MemberInvite &&
          facts?.is_connected === true &&
          facts.is_blocked === false;
        if (!isStillEligible) {
          await manager.query(ANSWER_INVITE_SQL, [
            invitedRow.id,
            StudioPlaylistEditorStatus.Revoked,
            false,
          ]);
          return { answer: 'unavailable', playlist };
        }
        await manager.query(ANSWER_INVITE_SQL, [
          invitedRow.id,
          StudioPlaylistEditorStatus.Active,
          true,
        ]);
        return { answer: 'accepted', playlist };
      },
    );
    if (outcome.answer === 'unavailable') {
      throw studioError('studio_playlist_invite_unavailable');
    }
    const isAccepted = outcome.answer === 'accepted';
    await this.notifyOwnerOfAnswer(userId, outcome.playlist, isAccepted);
    return isAccepted
      ? this.playlistReads.getPlaylist(userId, playlistId)
      : null;
  }

  /** `GET :id/editor-candidates?q=`: co-owners of the credit persona for
   *  the owner of a persona-credited playlist. */
  async listCandidates(
    ownerId: string,
    playlistId: string,
    searchTerm: string | undefined,
  ): Promise<StudioPlaylistEditorCandidateList> {
    const playlist = await this.playlists.findOne({
      where: { id: playlistId },
    });
    if (!playlist) {
      throw studioError('studio_playlist_not_found');
    }
    if (playlist.userId !== ownerId) {
      throw await this.refusal(ownerId, playlistId);
    }
    if (!playlist.isCreditedToPersona) {
      throw studioError('studio_playlist_editor_source_mismatch');
    }
    if (!playlist.creditSubprofileId) {
      return { items: [] };
    }
    if (
      !(await isPlaylistCreditStanding(this.dataSource.manager, playlistId))
    ) {
      return { items: [] };
    }
    const trimmedTerm = searchTerm?.trim() ?? '';
    const rows: { user_id: string; is_editor: boolean }[] =
      await this.dataSource.query(EDITOR_CANDIDATES_SQL, [
        playlist.creditSubprofileId,
        ownerId,
        playlistId,
        trimmedTerm ? `%${escapeLikeTerm(trimmedTerm)}%` : null,
        STUDIO_LIMITS.playlistEditorCandidatesMax,
      ]);
    const people = await this.playlistReads.peopleByUserIds(
      rows.map((row) => row.user_id),
    );
    return {
      items: rows.map((row) => ({
        member: people.get(row.user_id) ?? toStudioPlaylistPerson(undefined),
        isEditor: row.is_editor,
      })),
    };
  }

  private async addEditorsUnderLock(
    manager: EntityManager,
    ownerId: string,
    playlistId: string,
    memberSlugs: string[],
    userIdBySlug: Map<string, string>,
  ): Promise<AddEditorsOutcome> {
    const { playlist } = await lockPlaylistFor(
      manager,
      playlistId,
      ownerId,
      'owner',
    );
    const source = playlist.isCreditedToPersona
      ? StudioPlaylistEditorSource.PersonaCoOwner
      : StudioPlaylistEditorSource.MemberInvite;
    const isPersonaPick = source === StudioPlaylistEditorSource.PersonaCoOwner;
    const liveRows: { user_id: string }[] = await manager.query(
      LIVE_EDITOR_USER_IDS_SQL,
      [playlistId],
    );
    const liveUserIds = new Set(liveRows.map((row) => row.user_id));
    // Members already invited or editing are skipped, and so are not
    // checked again.
    const newUserIds = [
      ...new Set(
        memberSlugs.flatMap((slug) => {
          const userId = userIdBySlug.get(slug);
          return userId && !liveUserIds.has(userId) ? [userId] : [];
        }),
      ),
    ];
    if (isPersonaPick) {
      await manager.query(LOCK_PICKED_CO_OWNER_ROWS_SQL, [
        playlist.creditSubprofileId,
        [...newUserIds, ownerId],
      ]);
      // Read under the roster lock: a persona whose credit stopped standing
      // takes no picks at all.
      if (!(await isPlaylistCreditStanding(manager, playlistId))) {
        throw editorIneligibleError(
          memberSlugs.map((memberSlug) => ({
            memberSlug,
            reason: 'persona_credit_lapsed',
          })),
        );
      }
    }
    const factsRows: EditorFactsRow[] = newUserIds.length
      ? await manager.query(EDITOR_FACTS_SQL, [
          newUserIds,
          ownerId,
          playlist.isCreditedToPersona ? playlist.creditSubprofileId : null,
        ])
      : [];
    const factsByUserId = new Map(factsRows.map((row) => [row.user_id, row]));
    const ineligibleMembers = memberSlugs.flatMap(
      (memberSlug): StudioPlaylistIneligibleMember[] => {
        const userId = userIdBySlug.get(memberSlug);
        if (userId && liveUserIds.has(userId)) {
          return [];
        }
        const reason = ineligibilityReasonOf(
          userId ? factsByUserId.get(userId) : undefined,
          userId,
          ownerId,
          source,
        );
        return reason ? [{ memberSlug, reason }] : [];
      },
    );
    if (ineligibleMembers.length) {
      throw editorIneligibleError(ineligibleMembers);
    }
    if (
      liveUserIds.size + newUserIds.length >
      STUDIO_LIMITS.playlistEditorsMax
    ) {
      throw studioError('studio_playlist_editor_cap');
    }
    if (newUserIds.length) {
      await manager.query(UPSERT_EDITORS_SQL, [
        playlistId,
        newUserIds,
        ownerId,
        source,
        isPersonaPick
          ? StudioPlaylistEditorStatus.Active
          : StudioPlaylistEditorStatus.Invited,
        isPersonaPick,
      ]);
    }
    return { playlist, source, newUserIds };
  }

  // The roster as this viewer reads it: a member blocked either way with
  // the viewer is left out (two editors can block each other and keep their
  // seats; an owner and editor block ends the seat).
  private async editorList(
    viewerId: string,
    playlistId: string,
    statuses: StudioPlaylistEditorStatus[],
  ): Promise<StudioPlaylistEditorList> {
    const rows = await this.editors.find({
      where: { playlistId, status: In(statuses) },
      order: { invitedAt: 'ASC', id: 'ASC' },
    });
    const blockedUserIds = await this.blockFilter.blockedUserIds(
      viewerId,
      rows.map((row) => row.userId),
    );
    const visibleRows = rows.filter((row) => !blockedUserIds.has(row.userId));
    const people = await this.playlistReads.peopleByUserIds(
      visibleRows.map((row) => row.userId),
    );
    // `peopleByUserIds` answers active accounts alone, so a member who is
    // paused, pending deletion or suspended drops out of the roster.
    return {
      items: visibleRows.flatMap((row) => {
        const person = people.get(row.userId);
        return person ? [toStudioPlaylistEditorResponse(row, person)] : [];
      }),
    };
  }

  private refusal(
    viewerId: string,
    playlistId: string,
  ): Promise<HttpException> {
    return playlistRoleRefusal(() =>
      this.playlistReads.isOpenToViewer(viewerId, playlistId),
    );
  }

  private async transactionRetryingDeadlockOnce<Result>(
    work: (manager: EntityManager) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (!isDeadlockError(error)) {
        throw error;
      }
      return this.dataSource.transaction(work);
    }
  }

  // Maps a role refusal to 403 or 404 once the transaction has rolled back.
  private async withPlaylistRole<Result>(
    userId: string,
    playlistId: string,
    run: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof StudioPlaylistRoleRefusal) {
        throw await this.refusal(userId, playlistId);
      }
      throw error;
    }
  }

  private async notifyNewEditors(
    ownerId: string,
    outcome: AddEditorsOutcome,
  ): Promise<void> {
    if (!outcome.newUserIds.length) {
      return;
    }
    const basePayload = {
      playlistId: outcome.playlist.id,
      playlistName: outcome.playlist.name,
      actorId: ownerId,
    };
    try {
      if (outcome.source === StudioPlaylistEditorSource.MemberInvite) {
        await this.notifications.createForRecipients(
          outcome.newUserIds,
          NotificationType.StudioPlaylistEditorInvite,
          basePayload,
          ownerId,
        );
        return;
      }
      const personaName = await this.personaNameOf(
        outcome.playlist.creditSubprofileId,
      );
      await this.notifications.createForRecipients(
        outcome.newUserIds,
        NotificationType.StudioPlaylistEditorAdded,
        { ...basePayload, personaName },
        ownerId,
      );
    } catch (error) {
      this.logger.warn(`Playlist editor notification failed: ${String(error)}`);
    }
  }

  private async notifyOwnerOfAnswer(
    responderId: string,
    playlist: StudioPlaylist,
    isAccepted: boolean,
  ): Promise<void> {
    try {
      await this.notifications.create(
        playlist.userId,
        isAccepted
          ? NotificationType.StudioPlaylistEditorInviteAccepted
          : NotificationType.StudioPlaylistEditorInviteDeclined,
        {
          playlistId: playlist.id,
          playlistName: playlist.name,
          actorId: responderId,
        },
        responderId,
      );
    } catch (error) {
      this.logger.warn(
        `Playlist invitation answer notification failed: ${String(error)}`,
      );
    }
  }

  private async personaNameOf(subprofileId: string | null): Promise<string> {
    if (!subprofileId) {
      return '';
    }
    const rows: { persona_name: string }[] = await this.dataSource.query(
      PERSONA_NAME_SQL,
      [subprofileId],
    );
    return rows[0]?.persona_name ?? '';
  }
}
