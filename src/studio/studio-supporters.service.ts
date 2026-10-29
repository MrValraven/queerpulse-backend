import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { SubprofileFollowersService } from '../subprofiles/subprofile-followers.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import {
  artistRefFromColumns,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  blockedWithAnyPersonaMemberSql,
  chosenPersonaShowableSql,
  personaIdentityBlockedBySql,
  personaMemberUserIdsSql,
} from './studio-persona-members';
import { studioPersonaTrackIdsSql } from './studio-play-attribution';
import { toStudioCount } from './studio-stats';
import { toStudioSupportLinks } from './studio-support-links';
import {
  STUDIO_SUPPORTER_WINDOW_INTERVAL,
  STUDIO_TOP_SUPPORTERS_SHOWN,
  StudioSupporterOption,
  StudioSupporterState,
  StudioSupportingItem,
  StudioSupportingResponse,
  StudioTopSupporters,
  SupporterPersonaRow,
  toStudioSupporterIdentity,
} from './studio-supporters';
import { listenablePersonaSql } from './studio-visibility';
import {
  STUDIO_ARTIST_PERSONA_KINDS,
  STUDIO_SUPPORT_PLATFORMS,
  studioError,
} from './studio.constants';

/**
 * The artist rule every supporter read applies to the artist persona: a
 * Studio artist kind (`kindsParam`, a text array parameter), listenable, clear
 * of blocks either way between the caller and any persona member, and clear
 * of an identity block the caller placed on the persona (ruling 4, direct or
 * carried). `callerExpression` is a uuid expression such as `$2::uuid`.
 */
function supportableArtistSql(
  artistAlias: string,
  callerExpression: string,
  kindsParam: string,
): string {
  const artistId = `"${artistAlias}"."id"`;
  return `"${artistAlias}"."kind"::text = ANY(${kindsParam}::text[])
   AND ${listenablePersonaSql(artistAlias)}
   AND NOT ${blockedWithAnyPersonaMemberSql(callerExpression, artistId)}
   AND NOT ${personaIdentityBlockedBySql(`(${callerExpression})`, artistId)}`;
}

/**
 * Section 8 eligibility of one supporter opt-in row for the persona `$1`:
 * an active account with a Studio grant, clear of blocks either way with
 * every persona member, outside the persona members today, still a member
 * of the persona it chose to show, that chosen persona clear of an
 * identity block by any persona member (ruling 4), and that chosen persona
 * neither removed nor taken down by a moderator. The listen rule is applied
 * by the ranking alone.
 */
function eligibleSupporterSql(supporterAlias: string): string {
  const supporter = `"${supporterAlias}"`;
  return `${supporter}."subprofile_id" = $1::uuid
   AND EXISTS (
     SELECT 1 FROM "users" "supporter_user"
      WHERE "supporter_user"."id" = ${supporter}."user_id"
        AND "supporter_user"."status" = '${UserStatus.Active}'
   )
   AND EXISTS (
     SELECT 1 FROM "studio_access_grants" "supporter_grant"
      WHERE "supporter_grant"."user_id" = ${supporter}."user_id"
   )
   AND NOT ${blockedWithAnyPersonaMemberSql(`${supporter}."user_id"`, '$1')}
   AND ${supporter}."user_id" NOT IN ${personaMemberUserIdsSql('$1')}
   AND (
     ${supporter}."shown_as_subprofile_id" IS NULL
     OR ${supporter}."user_id" IN ${personaMemberUserIdsSql(`${supporter}."shown_as_subprofile_id"`)}
   )
   AND NOT ${personaIdentityBlockedBySql(
     personaMemberUserIdsSql('$1'),
     `${supporter}."shown_as_subprofile_id"`,
   )}
   AND (
     ${supporter}."shown_as_subprofile_id" IS NULL
     OR ${chosenPersonaShowableSql(`${supporter}."shown_as_subprofile_id"`)}
   )`;
}

/** The columns `SupporterPersonaRow` reads, for a persona shown as an
 *  identity. */
function supporterPersonaColumnsSql(personaAlias: string): string {
  const persona = `"${personaAlias}"`;
  return `${persona}."id" AS "id",
          ${persona}."handle" AS "handle",
          ${persona}."display_name" AS "display_name",
          ${persona}."kind"::text AS "kind",
          ${persona}."avatar_url" AS "avatar_url",
          ${listenablePersonaSql(personaAlias)} AS "is_linkable"`;
}

/** `$1` the artist persona, `$2` the caller, `$3` the artist kinds: one row
 *  with the `artist_*` columns and `is_own_persona` when the caller may
 *  support the artist (or is one of its members), none otherwise. */
export const SUPPORTER_ARTIST_SQL = `SELECT ${personaColumnsSql('artist', 'artist')},
       EXISTS (
         SELECT 1 FROM ${personaMemberUserIdsSql('"artist"."id"')} "artist_member"
          WHERE "artist_member"."user_id" = $2::uuid
       ) AS "is_own_persona"
  FROM "subprofiles" "artist"
 WHERE "artist"."id" = $1::uuid
   AND ${supportableArtistSql('artist', '$2::uuid', '$3')}`;

/** `$1` the caller, `$2` the artist persona to leave out, `$3` one persona id
 *  or null for all: every persona the caller created or co-owns, any kind and
 *  any status, removed ones and ones under a moderator takedown left out (the
 *  owner side drops those, so the picker never offers them), by name then id. */
export const MEMBER_PERSONAS_SQL = `SELECT ${supporterPersonaColumnsSql('persona')}
  FROM "subprofiles" "persona"
 WHERE "persona"."removed_at" IS NULL
   AND "persona"."id" <> $2::uuid
   AND (
     "persona"."user_id" = $1::uuid
     OR EXISTS (
       SELECT 1 FROM "subprofile_members" "persona_membership"
        WHERE "persona_membership"."subprofile_id" = "persona"."id"
          AND "persona_membership"."user_id" = $1::uuid
     )
   )
   AND ($3::uuid IS NULL OR "persona"."id" = $3::uuid)
   AND ${chosenPersonaShowableSql('"persona"."id"')}
 ORDER BY "persona"."display_name" ASC, "persona"."id" ASC`;

/** `$1` persona ids: the chosen personas of a set of opt-in rows. */
export const SUPPORTER_PERSONAS_SQL = `SELECT ${supporterPersonaColumnsSql('persona')}
  FROM "subprofiles" "persona"
 WHERE "persona"."id" = ANY($1::uuid[])
 ORDER BY "persona"."id" ASC`;

/** `$1` the caller, `$2` the artist persona: the caller's opt-in, if any. */
export const SUPPORTER_ROW_SQL = `SELECT "supporter"."shown_as_subprofile_id" AS "shown_as_subprofile_id",
       "supporter"."created_at" AS "created_at"
  FROM "studio_supporters" "supporter"
 WHERE "supporter"."user_id" = $1::uuid
   AND "supporter"."subprofile_id" = $2::uuid`;

/** `$1` the caller, `$2` the artist persona, `$3` the persona shown or null
 *  for the account. `created_at` never moves; `updated_at` moves on a change
 *  of identity only. */
export const SUPPORTER_UPSERT_SQL = `INSERT INTO "studio_supporters" ("user_id", "subprofile_id", "shown_as_subprofile_id")
VALUES ($1, $2, $3)
ON CONFLICT ("user_id", "subprofile_id") DO UPDATE
   SET "shown_as_subprofile_id" = EXCLUDED."shown_as_subprofile_id", "updated_at" = now()
 WHERE "studio_supporters"."shown_as_subprofile_id" IS DISTINCT FROM EXCLUDED."shown_as_subprofile_id"`;

/** `$1` the caller, `$2` the artist persona. */
export const SUPPORTER_DELETE_SQL = `DELETE FROM "studio_supporters"
 WHERE "user_id" = $1::uuid
   AND "subprofile_id" = $2::uuid`;

/** `$1` the caller, `$2` the artist kinds: the caller's opt-ins whose artist
 *  still passes the artist rule, newest first. */
export const SUPPORTING_ROWS_SQL = `SELECT ${personaColumnsSql('artist', 'artist')},
       "supporter"."shown_as_subprofile_id" AS "shown_as_subprofile_id",
       "supporter"."created_at" AS "created_at"
  FROM "studio_supporters" "supporter"
  INNER JOIN "subprofiles" "artist" ON "artist"."id" = "supporter"."subprofile_id"
 WHERE "supporter"."user_id" = $1::uuid
   AND ${supportableArtistSql('artist', '$1::uuid', '$2')}
 ORDER BY "supporter"."created_at" DESC, "supporter"."subprofile_id" DESC`;

/** `$1` the artist persona, `$2` the limit: eligible supporters with a
 *  listen on the persona's own or credited tracks inside the window, by
 *  listen count, then opt-in date, then user id. The count orders the rows
 *  and stays inside the query. Each shown identity appears once, at its best
 *  rank: an account row is keyed by its user id and a persona row by the
 *  chosen persona id, so two co-owners who both show as the same persona
 *  yield one row (and the list never hints that the persona has several
 *  members). */
export const TOP_SUPPORTERS_SQL = `SELECT "best_ranked"."user_id" AS "user_id",
       "best_ranked"."shown_as_subprofile_id" AS "shown_as_subprofile_id"
  FROM (
    SELECT DISTINCT ON ("ranked"."identity_key")
           "ranked"."user_id", "ranked"."shown_as_subprofile_id",
           "ranked"."listen_count", "ranked"."created_at"
      FROM (
        SELECT "supporter"."user_id" AS "user_id",
               "supporter"."shown_as_subprofile_id" AS "shown_as_subprofile_id",
               "supporter"."created_at" AS "created_at",
               COUNT("listen"."id") AS "listen_count",
               CASE WHEN "supporter"."shown_as_subprofile_id" IS NULL
                    THEN 'account:' || "supporter"."user_id"::text
                    ELSE 'persona:' || "supporter"."shown_as_subprofile_id"::text
               END AS "identity_key"
          FROM "studio_supporters" "supporter"
          INNER JOIN "studio_listens" "listen"
            ON "listen"."user_id" = "supporter"."user_id"
           AND "listen"."played_at" >= now() - interval '${STUDIO_SUPPORTER_WINDOW_INTERVAL}'
           AND "listen"."track_id" IN ${studioPersonaTrackIdsSql('$1::uuid')}
         WHERE ${eligibleSupporterSql('supporter')}
         GROUP BY "supporter"."user_id", "supporter"."shown_as_subprofile_id", "supporter"."created_at"
      ) "ranked"
     ORDER BY "ranked"."identity_key", "ranked"."listen_count" DESC, "ranked"."created_at" ASC, "ranked"."user_id" ASC
  ) "best_ranked"
 ORDER BY "best_ranked"."listen_count" DESC, "best_ranked"."created_at" ASC, "best_ranked"."user_id" ASC
 LIMIT $2`;

/** `$1` the artist persona: how many opt-in rows are eligible, listens
 *  aside. */
export const OPTED_IN_COUNT_SQL = `SELECT COUNT(*)::int AS "count"
  FROM "studio_supporters" "supporter"
 WHERE ${eligibleSupporterSql('supporter')}`;

interface SupporterArtistRow extends Record<string, unknown> {
  artist_id: string;
  is_own_persona: boolean;
}

interface SupporterRow {
  shown_as_subprofile_id: string | null;
  created_at: Date | string;
}

interface SupportingRow extends Record<string, unknown> {
  artist_id: string;
  shown_as_subprofile_id: string | null;
  created_at: Date | string;
}

interface TopSupporterRow {
  user_id: string;
  shown_as_subprofile_id: string | null;
}

interface OptedInCountRow {
  count: number | string;
}

function toIsoString(value: Date | string): string {
  return new Date(value).toISOString();
}

function personasByIdOf(
  rows: SupporterPersonaRow[],
): Map<string, SupporterPersonaRow> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Supporters, contract Part 2 sections 4.4, 5 and 8 with ruling 4. A member
 * opts in to show as a supporter of an artist persona, as their account or
 * as a persona they are a member of. The artist side reads a ranked list of
 * identities only: the owner list carries no counts and no user ids, and the
 * opted-in total is floored with `toStudioCount`.
 */
@Injectable()
export class StudioSupportersService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(SubprofileSocialLink)
    private readonly socialLinks: Repository<SubprofileSocialLink>,
    private readonly followers: SubprofileFollowersService,
    private readonly ownership: StudioOwnershipService,
  ) {}

  /** Section 5.2: the artist rule (404) comes before the member rule (403). */
  async getSupporterState(
    userId: string,
    subprofileId: string,
  ): Promise<StudioSupporterState> {
    const artistId = await this.supportableArtistId(userId, subprofileId);
    return this.stateFor(userId, artistId);
  }

  /** Section 5.3: the artist, then the member rule, then the identity. */
  async setSupporter(
    userId: string,
    subprofileId: string,
    shownAsSubprofileId: string | null,
  ): Promise<StudioSupporterState> {
    const artistId = await this.supportableArtistId(userId, subprofileId);
    let storedShownAsId: string | null = null;
    if (shownAsSubprofileId !== null) {
      const personaRows: SupporterPersonaRow[] = await this.dataSource.query(
        MEMBER_PERSONAS_SQL,
        [userId, artistId, shownAsSubprofileId],
      );
      const chosenPersona = personaRows[0];
      if (!chosenPersona) {
        throw studioError('studio_supporter_identity_not_yours');
      }
      storedShownAsId = chosenPersona.id;
    }
    await this.dataSource.query(SUPPORTER_UPSERT_SQL, [
      userId,
      artistId,
      storedShownAsId,
    ]);
    return this.stateFor(userId, artistId);
  }

  /** Section 5.4: no persona checks, so a member can always withdraw. */
  async removeSupporter(userId: string, subprofileId: string): Promise<void> {
    await this.dataSource.query(SUPPORTER_DELETE_SQL, [userId, subprofileId]);
  }

  /** Section 4.4: the caller's opt-ins whose artist still passes the artist
   *  rule, newest first. */
  async listSupporting(userId: string): Promise<StudioSupportingResponse> {
    const rows: SupportingRow[] = await this.dataSource.query(
      SUPPORTING_ROWS_SQL,
      [userId, [...STUDIO_ARTIST_PERSONA_KINDS]],
    );
    if (!rows.length) {
      return { items: [] };
    }
    const artistIds = rows.map((row) => row.artist_id);
    const members = await new MemberLookup(this.profiles).byUserIds([userId]);
    const personasById = await this.chosenPersonasById(
      rows.map((row) => row.shown_as_subprofile_id),
    );
    const links = await this.socialLinks.find({
      where: {
        subprofileId: In(artistIds),
        platform: In([...STUDIO_SUPPORT_PLATFORMS]),
      },
      order: { position: 'ASC', createdAt: 'ASC', id: 'ASC' },
    });
    const linksByArtistId = new Map<string, SubprofileSocialLink[]>();
    for (const link of links) {
      const artistLinks = linksByArtistId.get(link.subprofileId) ?? [];
      artistLinks.push(link);
      linksByArtistId.set(link.subprofileId, artistLinks);
    }
    const followedArtistIds = await this.followers.viewerFollowingFor(
      userId,
      artistIds,
    );
    const items = rows.flatMap((row): StudioSupportingItem[] => {
      const shownAs = toStudioSupporterIdentity(
        row.shown_as_subprofile_id,
        members.get(userId),
        personasById,
      );
      if (!shownAs) {
        return [];
      }
      return [
        {
          artist: artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
          since: toIsoString(row.created_at),
          shownAs,
          supportLinks: toStudioSupportLinks(
            linksByArtistId.get(row.artist_id) ?? [],
          ),
          isFollowing: followedArtistIds.has(row.artist_id),
        },
      ];
    });
    return { items };
  }

  /** Section 8: owners and co-owners only; anyone else, and an unknown
   *  persona, 404 before any other read. */
  async listTopSupporters(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioTopSupporters> {
    if (!(await this.ownership.isPersonaMember(viewerId, subprofileId))) {
      throw new NotFoundException('Artist not found');
    }
    const rows: TopSupporterRow[] = await this.dataSource.query(
      TOP_SUPPORTERS_SQL,
      [subprofileId, STUDIO_TOP_SUPPORTERS_SHOWN],
    );
    const countRows: OptedInCountRow[] = await this.dataSource.query(
      OPTED_IN_COUNT_SQL,
      [subprofileId],
    );
    const members = await new MemberLookup(this.profiles).byUserIds(
      rows
        .filter((row) => row.shown_as_subprofile_id === null)
        .map((row) => row.user_id),
    );
    const personasById = await this.chosenPersonasById(
      rows.map((row) => row.shown_as_subprofile_id),
    );
    // The query keeps one row per shown identity; this guard keeps a
    // persona shown twice from ever reaching the owner list.
    const shownIdentityKeys = new Set<string>();
    const items = rows.flatMap((row) => {
      const identityKey =
        row.shown_as_subprofile_id === null
          ? `account:${row.user_id}`
          : `persona:${row.shown_as_subprofile_id}`;
      if (shownIdentityKeys.has(identityKey)) {
        return [];
      }
      const identity = toStudioSupporterIdentity(
        row.shown_as_subprofile_id,
        members.get(row.user_id),
        personasById,
      );
      if (!identity) {
        return [];
      }
      shownIdentityKeys.add(identityKey);
      return [{ identity }];
    });
    return {
      items,
      optedInCount: toStudioCount(Number(countRows[0]?.count ?? 0)),
    };
  }

  /** The artist's stored id when the caller may support it. Every artist
   *  refusal answers the same 404 body; a persona member answers 403. */
  private async supportableArtistId(
    userId: string,
    subprofileId: string,
  ): Promise<string> {
    const rows: SupporterArtistRow[] = await this.dataSource.query(
      SUPPORTER_ARTIST_SQL,
      [subprofileId, userId, [...STUDIO_ARTIST_PERSONA_KINDS]],
    );
    const artist = rows[0];
    if (!artist) {
      throw studioError('studio_supporter_artist_not_found');
    }
    if (artist.is_own_persona) {
      throw studioError('studio_supporter_own_persona');
    }
    return artist.artist_id;
  }

  /** "Your account" first, then the caller's personas by name, with the
   *  caller's opt-in when there is one. */
  private async stateFor(
    userId: string,
    artistId: string,
  ): Promise<StudioSupporterState> {
    const memberPersonaRows: SupporterPersonaRow[] =
      await this.dataSource.query(MEMBER_PERSONAS_SQL, [
        userId,
        artistId,
        null,
      ]);
    const supporterRows: SupporterRow[] = await this.dataSource.query(
      SUPPORTER_ROW_SQL,
      [userId, artistId],
    );
    const supporterRow = supporterRows[0];
    const members = await new MemberLookup(this.profiles).byUserIds([userId]);
    const member = members.get(userId);
    const personasById = personasByIdOf(memberPersonaRows);
    const chosenPersonaId = supporterRow?.shown_as_subprofile_id ?? null;
    if (chosenPersonaId !== null && !personasById.has(chosenPersonaId)) {
      // The chosen persona left the options (removed, or the caller left
      // it); the caller still sees what they picked until they pick again.
      for (const [personaId, personaRow] of await this.chosenPersonasById([
        chosenPersonaId,
      ])) {
        personasById.set(personaId, personaRow);
      }
    }
    const options = [
      ...this.optionFor(null, member, personasById),
      ...memberPersonaRows.flatMap((row) =>
        this.optionFor(row.id, member, personasById),
      ),
    ];
    if (!supporterRow) {
      return {
        isSupporting: false,
        shownAsSubprofileId: null,
        shownAs: null,
        since: null,
        options,
      };
    }
    return {
      isSupporting: true,
      shownAsSubprofileId: chosenPersonaId,
      shownAs: toStudioSupporterIdentity(chosenPersonaId, member, personasById),
      since: toIsoString(supporterRow.created_at),
      options,
    };
  }

  private optionFor(
    shownAsSubprofileId: string | null,
    member: MemberRef | undefined,
    personasById: ReadonlyMap<string, SupporterPersonaRow>,
  ): StudioSupporterOption[] {
    const identity = toStudioSupporterIdentity(
      shownAsSubprofileId,
      member,
      personasById,
    );
    return identity ? [{ shownAsSubprofileId, identity }] : [];
  }

  /** One read for every chosen persona of a set of opt-in rows. */
  private async chosenPersonasById(
    shownAsSubprofileIds: (string | null)[],
  ): Promise<Map<string, SupporterPersonaRow>> {
    const personaIds = [
      ...new Set(
        shownAsSubprofileIds.filter(
          (personaId): personaId is string => personaId !== null,
        ),
      ),
    ];
    if (!personaIds.length) {
      return new Map();
    }
    const personaRows: SupporterPersonaRow[] = await this.dataSource.query(
      SUPPORTER_PERSONAS_SQL,
      [personaIds],
    );
    return personasByIdOf(personaRows);
  }
}
