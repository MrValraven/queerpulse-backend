import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { memberDisplayName } from '../studio/studio-playlist-response';
import { Profile } from '../users/entities/profile.entity';
import { DataExportContribution } from './data-export-contributor';

interface PlaylistExportRow {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  credit_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PlaylistEntryExportRow {
  playlist_id: string;
  track_title: string | null;
  artist_name: string | null;
  added_at: Date;
}

/**
 * `saved` -> `studioPlaylists` (Studio v2): the playlists the member made,
 * each with its visibility, the persona it shows as (by that persona's name,
 * or null when it shows as the member), and its tracks by title and artist
 * name in playlist order. A track that is gone, or that a persona unlink
 * moved out of reach, keeps its date with a null title and artist.
 *
 * Raw SQL through the `DataSource`, so `AccountModule` needs no
 * `forFeature` registration for two tables it only reads. Listening history
 * and supporter opt-ins export under `activityLog`
 * (`StudioListeningExportContributor`).
 */
@Injectable()
export class StudioPlaylistsExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'studioPlaylists';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const playlists: PlaylistExportRow[] = await this.dataSource.query(
      `SELECT "playlist"."id" AS "id",
              "playlist"."name" AS "name",
              "playlist"."description" AS "description",
              "playlist"."visibility"::text AS "visibility",
              "credit_persona"."display_name" AS "credit_name",
              "playlist"."created_at" AS "created_at",
              "playlist"."updated_at" AS "updated_at"
         FROM "studio_playlists" "playlist"
         LEFT JOIN "subprofiles" "credit_persona"
           ON "credit_persona"."id" = "playlist"."credit_subprofile_id"
        WHERE "playlist"."user_id" = $1
        ORDER BY "playlist"."created_at" ASC, "playlist"."id" ASC`,
      [userId],
    );
    if (!playlists.length) {
      return [];
    }
    const entries: PlaylistEntryExportRow[] = await this.dataSource.query(
      `SELECT "entry"."playlist_id" AS "playlist_id",
              "track"."title" AS "track_title",
              "persona"."display_name" AS "artist_name",
              "entry"."added_at" AS "added_at"
         FROM "studio_playlist_tracks" "entry"
         LEFT JOIN "studio_tracks" "track" ON "track"."id" = "entry"."track_id"
         LEFT JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
         LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
        WHERE "entry"."playlist_id" = ANY($1::uuid[])
        ORDER BY "entry"."playlist_id", "entry"."position" ASC, "entry"."id" ASC`,
      [playlists.map((playlist) => playlist.id)],
    );
    return playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      visibility: playlist.visibility,
      creditName: playlist.credit_name,
      tracks: entries
        .filter((entry) => entry.playlist_id === playlist.id)
        .map((entry) => ({
          title: entry.track_title,
          artist: entry.artist_name,
          addedAt: entry.added_at.toISOString(),
        })),
      createdAt: playlist.created_at.toISOString(),
      updatedAt: playlist.updated_at.toISOString(),
    }));
  }
}

interface PersonaCreditExportRow {
  direction: 'given' | 'received';
  persona_name: string;
  other_persona_name: string;
  role: string;
  track_title: string;
  release_title: string;
  status: string;
  created_at: Date;
  responded_at: Date | null;
}

/** One side of a credit, as the member's own persona sees it. */
function creditSideSql(
  direction: 'given' | 'received',
  ownPersonaColumn: string,
): string {
  const ownAlias = direction === 'given' ? 'requesting' : 'credited';
  const otherAlias = direction === 'given' ? 'credited' : 'requesting';
  return `SELECT '${direction}' AS "direction",
              "${ownAlias}"."display_name" AS "persona_name",
              "${otherAlias}"."display_name" AS "other_persona_name",
              "credit"."role" AS "role",
              "track"."title" AS "track_title",
              "release"."title" AS "release_title",
              CAST("credit"."status" AS text) AS "status",
              "credit"."created_at" AS "created_at",
              "credit"."responded_at" AS "responded_at",
              "credit"."id" AS "credit_id"
         FROM "studio_persona_credits" "credit"
         INNER JOIN "subprofiles" "requesting"
            ON "requesting"."id" = "credit"."requested_by_subprofile_id"
         INNER JOIN "subprofiles" "credited"
            ON "credited"."id" = "credit"."subprofile_id"
         INNER JOIN "studio_tracks" "track" ON "track"."id" = "credit"."track_id"
         INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
        WHERE "credit"."${ownPersonaColumn}" IN (
          SELECT "member"."subprofile_id" FROM "subprofile_members" "member" WHERE "member"."user_id" = $1
        )`;
}

/**
 * `subprofiles` -> `studioPersonaCredits` (Studio discovery): every persona
 * credit touching a persona the member runs, one row per side. `given` rows
 * are credits the member's release persona requested; `received` rows are
 * credits to the member's persona. A credit between two personas the member
 * runs appears once on each side. Personas are named by their display names;
 * neither side's member account is read.
 *
 * It is the member's own data, so the export includes their credits even
 * when a block silenced them or the other persona is now private, and it
 * includes on purpose the declined rows the requester dismissed.
 *
 * Raw SQL through the `DataSource`, like the playlists above.
 */
@Injectable()
export class StudioPersonaCreditsExportContributor implements DataExportContribution {
  readonly category = 'subprofiles';
  readonly archiveKey = 'studioPersonaCredits';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: PersonaCreditExportRow[] = await this.dataSource.query(
      `SELECT "direction", "persona_name", "other_persona_name", "role",
              "track_title", "release_title", "status", "created_at", "responded_at"
         FROM (
           ${creditSideSql('given', 'requested_by_subprofile_id')}
           UNION ALL
           ${creditSideSql('received', 'subprofile_id')}
         ) "credit_row"
        ORDER BY "created_at" ASC, "credit_id" ASC, "direction" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      direction: row.direction,
      personaName: row.persona_name,
      otherPersonaName: row.other_persona_name,
      role: row.role,
      trackTitle: row.track_title,
      releaseTitle: row.release_title,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
    }));
  }
}

interface ReminderExportRow {
  release_title: string | null;
  artist_name: string;
  publish_at: Date | null;
  created_at: Date;
}

/**
 * `saved` -> `studioReleaseReminders` (Studio v3): the Notify me reminders
 * the member holds, by release title and artist name. A reminder lives
 * until its release drops, so this lists the ones still waiting. Every
 * reminder row is kept; the title shows only while the release is
 * scheduled or published (what the member could see when they set it), so
 * a release its artist took back to draft or staff took down exports a
 * null title.
 */
@Injectable()
export class StudioReleaseRemindersExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'studioReleaseReminders';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: ReminderExportRow[] = await this.dataSource.query(
      `SELECT CASE WHEN "release"."status" IN ('scheduled', 'published')
                   THEN "release"."title" END AS "release_title",
              "persona"."display_name" AS "artist_name",
              "release"."publish_at" AS "publish_at",
              "reminder"."created_at" AS "created_at"
         FROM "studio_release_reminders" "reminder"
        INNER JOIN "studio_releases" "release" ON "release"."id" = "reminder"."release_id"
        INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
        WHERE "reminder"."user_id" = $1
        ORDER BY "reminder"."created_at" ASC, "reminder"."release_id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      releaseTitle: row.release_title,
      artist: row.artist_name,
      publishAt: row.publish_at ? row.publish_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

interface PlaylistSeatExportRow {
  playlist_name: string;
  status: string;
  source: string;
  invited_at: Date;
  accepted_at: Date | null;
  ended_at: Date | null;
}

/**
 * `saved` -> `studioPlaylistSeats` (collaborative playlists): every editor
 * seat the member holds or held on another member's playlist, ended ones
 * included (declined, revoked, left), by playlist name. The owner and the
 * other editors are left unnamed: the rows are the member's own.
 */
@Injectable()
export class StudioPlaylistSeatsExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'studioPlaylistSeats';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: PlaylistSeatExportRow[] = await this.dataSource.query(
      `SELECT "playlist"."name" AS "playlist_name",
              CAST("editor"."status" AS text) AS "status",
              CAST("editor"."source" AS text) AS "source",
              "editor"."invited_at" AS "invited_at",
              "editor"."accepted_at" AS "accepted_at",
              "editor"."ended_at" AS "ended_at"
         FROM "studio_playlist_editors" "editor"
        INNER JOIN "studio_playlists" "playlist"
           ON "playlist"."id" = "editor"."playlist_id"
        WHERE "editor"."user_id" = $1
        ORDER BY "editor"."invited_at" ASC, "editor"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      playlistName: row.playlist_name,
      status: row.status,
      source: row.source,
      invitedAt: row.invited_at.toISOString(),
      acceptedAt: row.accepted_at ? row.accepted_at.toISOString() : null,
      endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    }));
  }
}

interface PlaylistAdditionExportRow {
  playlist_name: string;
  track_title: string | null;
  added_at: Date;
}

/**
 * `saved` -> `studioPlaylistAdditions` (collaborative playlists): the
 * entries the member added to playlists they do not own, while the entry
 * still names them (an ended seat clears "added by" on that playlist). A
 * track that is gone, or that a persona unlink moved out of reach, keeps
 * its date with a null title, as in `studioPlaylists`. The member's own
 * playlists stay in `studioPlaylists`.
 */
@Injectable()
export class StudioPlaylistAdditionsExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'studioPlaylistAdditions';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: PlaylistAdditionExportRow[] = await this.dataSource.query(
      `SELECT "playlist"."name" AS "playlist_name",
              "track"."title" AS "track_title",
              "entry"."added_at" AS "added_at"
         FROM "studio_playlist_tracks" "entry"
        INNER JOIN "studio_playlists" "playlist"
           ON "playlist"."id" = "entry"."playlist_id"
         LEFT JOIN "studio_tracks" "track" ON "track"."id" = "entry"."track_id"
        WHERE "entry"."added_by_user_id" = $1
          AND "playlist"."user_id" <> $1
        ORDER BY "entry"."added_at" ASC, "entry"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      playlistName: row.playlist_name,
      trackTitle: row.track_title,
      addedAt: row.added_at.toISOString(),
    }));
  }
}

interface CopyrightClaimExportRow {
  track_title: string;
  artist_name: string;
  status: string;
  claimant_role: string;
  original_work: string;
  original_link: string | null;
  details: string;
  counter_note: string | null;
  claimant_reply: string | null;
  staff_note: string | null;
  created_at: Date;
  accepted_at: Date | null;
  countered_at: Date | null;
  replied_at: Date | null;
  decided_at: Date | null;
}

const isoOrNull = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

/**
 * `reports` -> `studioCopyrightClaims` (Studio safety and moderation): the
 * copyright claims the member filed, by track title and artist name, with
 * every step: the artist's counter-notice, the member's reply and our
 * team's note. The deciding staff member stays out, as it does from the
 * claim views. A claim a persona unlink severed joins no live row and
 * exports the title and artist name kept at filing, so the archive never
 * names the pseudonymous persona; a live claim whose track went falls back
 * to those names too.
 */
@Injectable()
export class StudioCopyrightClaimsExportContributor implements DataExportContribution {
  readonly category = 'reports';
  readonly archiveKey = 'studioCopyrightClaims';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: CopyrightClaimExportRow[] = await this.dataSource.query(
      `SELECT COALESCE("track"."title", "claim"."track_title_at_filing") AS "track_title",
              COALESCE("persona"."display_name", "claim"."artist_name_at_filing") AS "artist_name",
              "claim"."status"::text AS "status",
              "claim"."claimant_role"::text AS "claimant_role",
              "claim"."original_work" AS "original_work",
              "claim"."original_link" AS "original_link",
              "claim"."details" AS "details",
              "claim"."counter_note" AS "counter_note",
              "claim"."claimant_reply" AS "claimant_reply",
              "claim"."staff_note" AS "staff_note",
              "claim"."created_at" AS "created_at",
              "claim"."accepted_at" AS "accepted_at",
              "claim"."countered_at" AS "countered_at",
              "claim"."replied_at" AS "replied_at",
              "claim"."decided_at" AS "decided_at"
         FROM "studio_copyright_claims" "claim"
         LEFT JOIN "studio_tracks" "track"
           ON "track"."id" = "claim"."track_id" AND NOT "claim"."is_severed"
         LEFT JOIN "studio_releases" "release"
           ON "release"."id" = "claim"."release_id" AND NOT "claim"."is_severed"
         LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
        WHERE "claim"."claimant_id" = $1
        ORDER BY "claim"."created_at" ASC, "claim"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      trackTitle: row.track_title,
      artist: row.artist_name,
      status: row.status,
      claimantRole: row.claimant_role,
      originalWork: row.original_work,
      originalLink: row.original_link,
      details: row.details,
      counterNote: row.counter_note,
      claimantReply: row.claimant_reply,
      staffNote: row.staff_note,
      createdAt: row.created_at.toISOString(),
      acceptedAt: isoOrNull(row.accepted_at),
      counteredAt: isoOrNull(row.countered_at),
      repliedAt: isoOrNull(row.replied_at),
      decidedAt: isoOrNull(row.decided_at),
    }));
  }
}

interface PlaylistFolderExportRow {
  id: string;
  name: string;
  position: number;
  created_at: Date;
}

interface PlaylistFilingExportRow {
  folder_id: string;
  playlist_id: string;
  filed_at: Date;
}

/**
 * `saved` -> `studioPlaylistFolders` (Studio playlist folders): the
 * member's folders in their order, each with the playlists they filed in
 * it, by playlist id and the time they filed it. Playlist names are left
 * out: a folder can hold another member's playlist, whose name is theirs.
 * Folders and filings are private to the member, so nothing else is read.
 */
@Injectable()
export class StudioPlaylistFoldersExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'studioPlaylistFolders';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const folders: PlaylistFolderExportRow[] = await this.dataSource.query(
      `SELECT "folder"."id" AS "id",
              "folder"."name" AS "name",
              "folder"."position" AS "position",
              "folder"."created_at" AS "created_at"
         FROM "studio_playlist_folders" "folder"
        WHERE "folder"."user_id" = $1
        ORDER BY "folder"."position" ASC, "folder"."id" ASC`,
      [userId],
    );
    if (!folders.length) {
      return [];
    }
    const filings: PlaylistFilingExportRow[] = await this.dataSource.query(
      `SELECT "item"."folder_id" AS "folder_id",
              "item"."playlist_id" AS "playlist_id",
              "item"."created_at" AS "filed_at"
         FROM "studio_playlist_folder_items" "item"
        WHERE "item"."user_id" = $1
        ORDER BY "item"."created_at" ASC, "item"."id" ASC`,
      [userId],
    );
    return folders.map((folder) => ({
      name: folder.name,
      position: folder.position,
      createdAt: folder.created_at.toISOString(),
      playlists: filings
        .filter((filing) => filing.folder_id === folder.id)
        .map((filing) => ({
          playlistId: filing.playlist_id,
          filedAt: filing.filed_at.toISOString(),
        })),
    }));
  }
}

interface ListenExportRow {
  track_title: string | null;
  artist: string | null;
  played_at: Date;
}

interface SupporterExportRow {
  artist: string | null;
  shown_as: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * `activityLog` -> `studioListening` (Studio listening): the member's own
 * history and opt-ins. Every listen comes first, oldest first, with the
 * track title while its release is published (a null title once the
 * release left publication) and the artist persona; the supporter
 * opt-ins follow, oldest first, each naming the artist and how the member
 * shows themselves ("account" or the chosen persona's display name).
 * Daily play totals carry no member and are not personal data.
 */
@Injectable()
export class StudioListeningExportContributor implements DataExportContribution {
  readonly category = 'activityLog';
  readonly archiveKey = 'studioListening';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const listens: ListenExportRow[] = await this.dataSource.query(
      `SELECT CASE WHEN "release"."status" = 'published' THEN "track"."title" END AS "track_title",
              "persona"."display_name" AS "artist",
              "listen"."played_at" AS "played_at"
         FROM "studio_listens" "listen"
         LEFT JOIN "studio_tracks" "track" ON "track"."id" = "listen"."track_id"
         LEFT JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
         LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
        WHERE "listen"."user_id" = $1
        ORDER BY "listen"."played_at" ASC, "listen"."id" ASC`,
      [userId],
    );
    const supporters: SupporterExportRow[] = await this.dataSource.query(
      `SELECT "artist"."display_name" AS "artist",
              "chosen"."display_name" AS "shown_as",
              "supporter"."created_at" AS "created_at",
              "supporter"."updated_at" AS "updated_at"
         FROM "studio_supporters" "supporter"
         LEFT JOIN "subprofiles" "artist" ON "artist"."id" = "supporter"."subprofile_id"
         LEFT JOIN "subprofiles" "chosen" ON "chosen"."id" = "supporter"."shown_as_subprofile_id"
        WHERE "supporter"."user_id" = $1
        ORDER BY "supporter"."created_at" ASC, "supporter"."subprofile_id" ASC`,
      [userId],
    );
    return [
      ...listens.map((listen) => ({
        type: 'listen',
        trackTitle: listen.track_title,
        artist: listen.artist,
        playedAt: listen.played_at.toISOString(),
      })),
      ...supporters.map((supporter) => ({
        type: 'supporter',
        artist: supporter.artist,
        shownAs: supporter.shown_as ?? 'account',
        createdAt: supporter.created_at.toISOString(),
        updatedAt: supporter.updated_at.toISOString(),
      })),
    ];
  }
}

interface AccessRequestExportRow {
  wants_to_release: boolean;
  created_at: Date;
}

/**
 * `profile` -> `studioAccessRequest` (Studio access request): the member's
 * own waiting request for Studio access, as one row with whether they want
 * to release music and when they asked. A member without a waiting request
 * has no row. The grant itself is staff data, and the request row goes
 * with the account.
 */
@Injectable()
export class StudioAccessRequestExportContributor implements DataExportContribution {
  readonly category = 'profile';
  readonly archiveKey = 'studioAccessRequest';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const requests: AccessRequestExportRow[] = await this.dataSource.query(
      `SELECT "request"."wants_to_release" AS "wants_to_release",
              "request"."created_at" AS "created_at"
         FROM "studio_access_requests" "request"
        WHERE "request"."user_id" = $1`,
      [userId],
    );
    return requests.map((request) => ({
      wantsToRelease: request.wants_to_release,
      requestedAt: request.created_at.toISOString(),
    }));
  }
}

interface PurchaseExportRow {
  item_kind: string;
  item_title: string;
  artist_name: string;
  amount_cents: number;
  reference_code: string;
  payer_name: string | null;
  status: string;
  decline_reason: string | null;
  decline_note: string | null;
  is_on_wall: boolean;
  shown_as: string | null;
  created_at: Date;
  decided_at: Date | null;
}

/**
 * `activityLog` -> `studioPurchases` (Studio purchases): the buyer's own
 * records of the purchases they reported, oldest first, with the item
 * title and artist name kept at purchase time, the amount, reference code
 * and payer name they entered, the status and decline reason the artist
 * set, and the wall choice. `shownAs` is "account" when the member shows
 * on the wall as themselves, the chosen persona's display name when they
 * show as a persona, and null while the wall is off.
 *
 * Amounts and payment details leave only to the member who already sees
 * them. Raw SQL through the `DataSource`, like the contributors above.
 */
@Injectable()
export class StudioPurchasesExportContributor implements DataExportContribution {
  readonly category = 'activityLog';
  readonly archiveKey = 'studioPurchases';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: PurchaseExportRow[] = await this.dataSource.query(
      `SELECT "purchase"."item_kind"::text AS "item_kind",
              "purchase"."item_title" AS "item_title",
              "purchase"."artist_name" AS "artist_name",
              "purchase"."amount_cents" AS "amount_cents",
              "purchase"."reference_code" AS "reference_code",
              "purchase"."payer_name" AS "payer_name",
              "purchase"."status"::text AS "status",
              "purchase"."decline_reason"::text AS "decline_reason",
              "purchase"."decline_note" AS "decline_note",
              "purchase"."is_on_wall" AS "is_on_wall",
              CASE WHEN NOT "purchase"."is_on_wall" THEN NULL
                   WHEN "purchase"."is_shown_as_persona" THEN "chosen"."display_name"
                   ELSE 'account' END AS "shown_as",
              "purchase"."created_at" AS "created_at",
              "purchase"."decided_at" AS "decided_at"
         FROM "studio_purchases" "purchase"
         LEFT JOIN "subprofiles" "chosen"
           ON "chosen"."id" = "purchase"."shown_as_subprofile_id"
        WHERE "purchase"."buyer_user_id" = $1
        ORDER BY "purchase"."created_at" ASC, "purchase"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      itemKind: row.item_kind,
      itemTitle: row.item_title,
      artist: row.artist_name,
      amountCents: row.amount_cents,
      referenceCode: row.reference_code,
      payerName: row.payer_name,
      status: row.status,
      declineReason: row.decline_reason,
      declineNote: row.decline_note,
      isOnWall: row.is_on_wall,
      shownAs: row.shown_as,
      createdAt: row.created_at.toISOString(),
      decidedAt: isoOrNull(row.decided_at),
    }));
  }
}

interface SalePersonaExportRow {
  id: string;
  display_name: string;
}

interface PaymentMethodExportRow {
  subprofile_id: string;
  kind: string;
  label: string | null;
  value: string;
  note: string | null;
  position: number;
}

interface SaleExportRow {
  subprofile_id: string;
  buyer_user_id: string | null;
  item_kind: string;
  item_title: string;
  amount_cents: number;
  reference_code: string;
  payer_name: string | null;
  status: string;
  decline_reason: string | null;
  decline_note: string | null;
  created_at: Date;
  decided_at: Date | null;
}

/**
 * `subprofiles` -> `studioSales` (Studio purchases): for every persona the
 * member runs (read through `subprofile_members`), the payment methods the
 * persona lists, in their order, then every sale reported to it, oldest
 * first and in every status, as the persona's members see them in the
 * inbox. `buyer` is the buyer's account display name, or "Deleted account"
 * once the buyer's account is gone.
 *
 * Amounts and payment details leave only to the member who already sees
 * them. Raw SQL through the `DataSource`; the buyer names come from one
 * batched profile read.
 */
@Injectable()
export class StudioSalesExportContributor implements DataExportContribution {
  readonly category = 'subprofiles';
  readonly archiveKey = 'studioSales';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const personas: SalePersonaExportRow[] = await this.dataSource.query(
      `SELECT "persona"."id" AS "id", "persona"."display_name" AS "display_name"
         FROM "subprofiles" "persona"
        WHERE "persona"."id" IN (
          SELECT "member"."subprofile_id" FROM "subprofile_members" "member" WHERE "member"."user_id" = $1
        )
        ORDER BY "persona"."display_name" ASC, "persona"."id" ASC`,
      [userId],
    );
    if (!personas.length) {
      return [];
    }
    const personaIds = personas.map((persona) => persona.id);
    const personaNames = new Map(
      personas.map((persona) => [persona.id, persona.display_name]),
    );
    const methods: PaymentMethodExportRow[] = await this.dataSource.query(
      `SELECT "method"."subprofile_id" AS "subprofile_id",
              "method"."kind"::text AS "kind",
              "method"."label" AS "label",
              "method"."value" AS "value",
              "method"."note" AS "note",
              "method"."position" AS "position"
         FROM "studio_payment_methods" "method"
        WHERE "method"."subprofile_id" = ANY($1::uuid[])
        ORDER BY "method"."subprofile_id" ASC, "method"."position" ASC`,
      [personaIds],
    );
    const sales: SaleExportRow[] = await this.dataSource.query(
      `SELECT "sale"."subprofile_id" AS "subprofile_id",
              "sale"."buyer_user_id" AS "buyer_user_id",
              "sale"."item_kind"::text AS "item_kind",
              "sale"."item_title" AS "item_title",
              "sale"."amount_cents" AS "amount_cents",
              "sale"."reference_code" AS "reference_code",
              "sale"."payer_name" AS "payer_name",
              "sale"."status"::text AS "status",
              "sale"."decline_reason"::text AS "decline_reason",
              "sale"."decline_note" AS "decline_note",
              "sale"."created_at" AS "created_at",
              "sale"."decided_at" AS "decided_at"
         FROM "studio_purchases" "sale"
        WHERE "sale"."subprofile_id" = ANY($1::uuid[])
        ORDER BY "sale"."created_at" ASC, "sale"."id" ASC`,
      [personaIds],
    );
    const buyerIds = [
      ...new Set(
        sales.flatMap((sale) =>
          sale.buyer_user_id ? [sale.buyer_user_id] : [],
        ),
      ),
    ];
    const buyers = await new MemberLookup(
      this.dataSource.getRepository(Profile),
    ).byUserIds(buyerIds);
    return [
      ...methods.map((method) => ({
        type: 'paymentMethod',
        persona: personaNames.get(method.subprofile_id) ?? null,
        kind: method.kind,
        label: method.label,
        value: method.value,
        note: method.note,
        position: method.position,
      })),
      ...sales.map((sale) => ({
        type: 'sale',
        persona: personaNames.get(sale.subprofile_id) ?? null,
        itemKind: sale.item_kind,
        itemTitle: sale.item_title,
        amountCents: sale.amount_cents,
        referenceCode: sale.reference_code,
        payerName: sale.payer_name,
        buyer: sale.buyer_user_id
          ? memberDisplayName(buyers.get(sale.buyer_user_id))
          : 'Deleted account',
        status: sale.status,
        declineReason: sale.decline_reason,
        declineNote: sale.decline_note,
        createdAt: sale.created_at.toISOString(),
        decidedAt: isoOrNull(sale.decided_at),
      })),
    ];
  }
}
