import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { MemberSuggestionDismissal } from './entities/member-suggestion-dismissal.entity';
import {
  compareSuggestions,
  isEmptyAffinity,
  scoreSuggestion,
  type CandidateAffinity,
  type SuggestionScore,
  type ViewerAffinity,
} from './member-suggestion-scoring';
import {
  toSuggestedMember,
  visibleOpenTo,
  type SuggestedMember,
} from './member-suggestion-response';

/** How many people the strip asks for by default, and the ceiling a client
 *  may ask for. Small on purpose: a suggestion surface that scrolls stops
 *  being a suggestion and becomes a second directory. */
export const DEFAULT_SUGGESTION_LIMIT = 6;
export const MAX_SUGGESTION_LIMIT = 20;

/** Ceilings on how much of the graph one request will walk.
 *
 *  Each is a bound on ROWS READ, so cost stays flat as the platform grows
 *  rather than scaling with the size of a big community. The pool is re-drawn
 *  on every request and every scan is ordered newest-first, so dismissing the
 *  people a member already knows keeps handing them different faces over
 *  time. */
const MAX_ROSTER_ROWS_SCANNED = 600;
const MAX_FRIEND_OF_FRIEND_EDGES = 600;
const MAX_INTEREST_MATCHES = 200;
const MAX_CANDIDATES = 300;

/** The moderation subject type members are reported under. Mirrors
 *  `ProfilesService.MEMBER_SUBJECT_TYPE`, which is private to that service; a
 *  report can key a member by either their slug or their user id, so both are
 *  checked. */
const MEMBER_SUBJECT_TYPE = 'member';

/** A candidate that survived every exclusion, with its facts resolved. */
interface ScoredCandidate {
  profile: Profile;
  scored: SuggestionScore;
}

/**
 * People discovery (SOC-05): `GET /members/suggested`.
 *
 * The scoring itself lives in `./member-suggestion-scoring.ts`, which is a
 * pure module and carries the full product reasoning (why identity is not a
 * signal, why nothing behavioural is read, why every card must be able to say
 * why). This service is the part that talks to the database: it draws a
 * bounded candidate pool out of the viewer's own graph, applies EVERY
 * exclusion the member directory applies plus the ones a push surface needs,
 * and then scores what is left.
 *
 * THE EXCLUSIONS ARE THE FEATURE. A directory is something a member walked
 * into; a suggestion is something the platform walked up to them with. So the
 * gates here are the directory's, reused verbatim from the same two services
 * `ProfilesService.searchMembers` uses, plus four more:
 *
 *   1. the viewer themself, who the directory legitimately does list;
 *   2. anyone the viewer already has ANY connection row with, in either
 *      direction and at any status. Accepted means there is nothing to
 *      suggest; pending means it is already asked; declined and blocked mean
 *      an answer was given, and asking again through a different surface
 *      would be a way around it;
 *   3. anyone the viewer has dismissed from this strip;
 *   4. anyone a moderator has hidden or removed. The directory does not carry
 *      this gate (it is applied per profile, on open), but pushing a
 *      taken-down member into someone's feed is a different thing from
 *      listing them behind a search;
 *   5. anyone who has switched off "Appear in suggested connections"
 *      (`member_preferences.hide_from_suggestions`, PRD-16). Until that column
 *      existed the only lever a member had over being recommended to strangers
 *      was the 24-hour `hidden_until` blackout, which also took them out of
 *      the member directory. This one is narrower and permanent: they stay
 *      listed, findable and visible exactly as `profiles.visibility` says, and
 *      the platform stops walking up to people with them.
 *
 * The fifth gate is ONE-DIRECTIONAL. Opting out stops a member being
 * suggested; it never stops them seeing suggestions. Their own strip is built
 * from their graph and their own visibility choices, none of which they have
 * changed, and charging them their own discovery for a privacy decision would
 * make the switch something members warn each other not to touch.
 */
@Injectable()
export class MemberSuggestionsService {
  constructor(
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(MemberSuggestionDismissal)
    private readonly dismissals: Repository<MemberSuggestionDismissal>,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
    private readonly hiddenFrom: HiddenFromService,
    private readonly contentModeration: ContentModerationService,
  ) {}

  /**
   * The strip's payload. Returns an empty list rather than a filler of
   * strangers whenever there is nothing honest to offer: a member who has
   * joined nothing, connected with nobody and written nothing about
   * themselves gets no suggestions at all, and the client renders its plain
   * empty state.
   */
  async suggest(
    viewerUserId: string,
    requestedLimit?: number,
  ): Promise<SuggestedMember[]> {
    const limit = Math.min(
      Math.max(1, requestedLimit ?? DEFAULT_SUGGESTION_LIMIT),
      MAX_SUGGESTION_LIMIT,
    );
    const viewerProfile = await this.profiles.findOne({
      where: { userId: viewerUserId },
    });
    if (!viewerProfile) {
      return [];
    }

    const [rosterCommunityNames, connectionUserIds] = await Promise.all([
      this.viewerRosterCommunities(viewerUserId),
      this.connectionsService.getAcceptedConnectionUserIds(viewerUserId),
    ]);
    const viewer: ViewerAffinity = {
      communityNamesById: rosterCommunityNames,
      connectionUserIds: new Set(connectionUserIds),
      openTo: viewerProfile.openTo ?? [],
      tags: toComparableSet(viewerProfile.tags),
      professions: toComparableSet([
        ...(viewerProfile.profession ?? []),
        ...(viewerProfile.discipline ?? []),
      ]),
      languages: toComparableSet(viewerProfile.languages),
    };
    if (isEmptyAffinity(viewer)) {
      return [];
    }

    const communityIdsByCandidate = await this.coMembersByCommunity([
      ...viewer.communityNamesById.keys(),
    ]);
    const friendsOfFriends = await this.friendsOfFriends(connectionUserIds);
    const interestMatches = await this.interestMatches(viewer);

    const candidateIds = new Set<string>([
      ...communityIdsByCandidate.keys(),
      ...friendsOfFriends,
      ...interestMatches,
    ]);
    candidateIds.delete(viewerUserId);
    for (const connectedId of connectionUserIds) {
      // Cheap pre-filter. The SQL gate below is the authoritative one (it also
      // catches pending, declined and blocked rows), but dropping the viewer's
      // own accepted connections here keeps the pool from filling up with
      // people who can never be suggested.
      candidateIds.delete(connectedId);
    }
    if (!candidateIds.size) {
      return [];
    }

    const visible = await this.visibleCandidates(viewerUserId, [
      ...candidateIds,
    ]);
    if (!visible.length) {
      return [];
    }

    const allowed = await this.dropTakenDown(visible);
    if (!allowed.length) {
      return [];
    }

    const mutualCounts = await this.connectionsService.mutualCountsByUserIds(
      viewerUserId,
      allowed.map((profile) => profile.userId),
    );

    const scored: ScoredCandidate[] = [];
    for (const profile of allowed) {
      const candidate: CandidateAffinity = {
        communityIds: communityIdsByCandidate.get(profile.userId) ?? [],
        mutualConnectionCount: mutualCounts.get(profile.userId) ?? 0,
        openTo: visibleOpenTo(profile),
        tags: profile.tags ?? [],
        professions: [
          ...(profile.profession ?? []),
          ...(profile.discipline ?? []),
        ],
        languages: profile.languages ?? [],
      };
      const result = scoreSuggestion(viewer, candidate);
      if (result.score > 0 && result.reason) {
        scored.push({ profile, scored: result });
      }
    }

    scored.sort((first, second) => {
      const byScore = compareSuggestions(first.scored, second.scored);
      if (byScore !== 0) return byScore;
      // Stable fallback: newest member first, then slug, so two people with
      // identical facts always come back in the same order rather than in
      // whatever order the rows arrived.
      const byJoined =
        second.profile.joinedAt.getTime() - first.profile.joinedAt.getTime();
      if (byJoined !== 0) return byJoined;
      return first.profile.slug.localeCompare(second.profile.slug);
    });

    return scored
      .slice(0, limit)
      .map((entry) =>
        toSuggestedMember(
          entry.profile,
          entry.scored.reason!,
          entry.scored.score,
        ),
      );
  }

  /**
   * "Not this person." Idempotent, silent, and reversible only by the member
   * themself (there is no un-dismiss route today, and the dismissed person is
   * never told). Dismissing yourself is a no-op rather than an error: there is
   * nothing to remember, since the viewer is excluded from their own
   * suggestions anyway.
   */
  async dismiss(
    viewerUserId: string,
    slug: string,
  ): Promise<{ dismissed: true }> {
    const target = await this.profiles.findOne({
      where: { slug },
      select: { userId: true },
    });
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    if (target.userId === viewerUserId) {
      return { dismissed: true };
    }
    // `UQ_member_suggestion_dismissals` makes the double-tap a no-op at the DB
    // level instead of a 23505 this service would have to catch.
    await this.dismissals
      .createQueryBuilder()
      .insert()
      .values({ userId: viewerUserId, dismissedUserId: target.userId })
      .orIgnore()
      .execute();
    return { dismissed: true };
  }

  /**
   * The viewer's own rooms, keyed by id with their display name.
   *
   * Only communities whose roster the viewer can actually see are returned:
   * an archived community is gone for everyone, and one with
   * `roster_visible = false` deliberately hides who is inside it. Saying "you
   * are both in X" about a hidden roster would leak exactly the fact that
   * setting exists to keep, so those rooms cannot score and cannot explain.
   */
  private async viewerRosterCommunities(
    viewerUserId: string,
  ): Promise<Map<string, string>> {
    const rows = await this.communityMembers.find({
      where: { userId: viewerUserId },
      select: { communityId: true },
    });
    const communityIds = rows.map((row) => row.communityId);
    if (!communityIds.length) {
      return new Map();
    }
    const communities = await this.communities.find({
      where: { id: In(communityIds), rosterVisible: true },
      select: { id: true, name: true, archivedAt: true },
    });
    return new Map(
      communities
        .filter((community) => community.archivedAt === null)
        .map((community) => [community.id, community.name]),
    );
  }

  /** Everyone on the roster of one of the viewer's rooms, with the rooms they
   *  share. One bounded query, ordered so the scan is deterministic. */
  private async coMembersByCommunity(
    communityIds: string[],
  ): Promise<Map<string, string[]>> {
    const byCandidate = new Map<string, string[]>();
    if (!communityIds.length) {
      return byCandidate;
    }
    const rows = await this.communityMembers.find({
      where: { communityId: In(communityIds) },
      select: { userId: true, communityId: true },
      order: { joinedAt: 'DESC' },
      take: MAX_ROSTER_ROWS_SCANNED,
    });
    for (const row of rows) {
      const existing = byCandidate.get(row.userId);
      if (existing) {
        existing.push(row.communityId);
      } else {
        byCandidate.set(row.userId, [row.communityId]);
      }
    }
    return byCandidate;
  }

  /**
   * The far ends of the viewer's connections' own accepted connections.
   *
   * This is the id pool only. The COUNT that scores and explains comes from
   * `ConnectionsService.mutualCountsByUserIds`, which is already batched and
   * already the platform's single definition of "mutual connection", so this
   * method deliberately does not compute one of its own.
   */
  private async friendsOfFriends(
    connectionUserIds: string[],
  ): Promise<Set<string>> {
    const farEnds = new Set<string>();
    if (!connectionUserIds.length) {
      return farEnds;
    }
    const edges = await this.connections.find({
      where: [
        {
          requesterId: In(connectionUserIds),
          status: ConnectionStatus.Accepted,
        },
        {
          addresseeId: In(connectionUserIds),
          status: ConnectionStatus.Accepted,
        },
      ],
      select: { requesterId: true, addresseeId: true },
      order: { createdAt: 'DESC' },
      take: MAX_FRIEND_OF_FRIEND_EDGES,
    });
    const direct = new Set(connectionUserIds);
    for (const edge of edges) {
      for (const candidate of [edge.requesterId, edge.addresseeId]) {
        if (!direct.has(candidate)) {
          farEnds.add(candidate);
        }
      }
    }
    return farEnds;
  }

  /**
   * People who wrote one of the same words the viewer did.
   *
   * Only the two `text[]` columns are searchable this way (`&&` is the array
   * overlap operator). `open_to` is `jsonb` and has no equivalent cheap
   * index, so it never RECRUITS a candidate; it still scores and explains for
   * a candidate the graph already surfaced. Identity columns are absent by
   * design, and `languages` is absent because a shared language cannot anchor
   * a suggestion (see the scoring module).
   */
  private async interestMatches(viewer: ViewerAffinity): Promise<Set<string>> {
    const tags = [...viewer.tags];
    const professions = [...viewer.professions];
    if (!tags.length && !professions.length) {
      return new Set();
    }
    const qb = this.profiles
      .createQueryBuilder('p')
      .select('"p"."user_id"', 'user_id');
    const clauses: string[] = [];
    // `unnest` + `lower` rather than the `&&` array-overlap operator: overlap
    // is case-sensitive, and two members who typed "Ballroom" and "ballroom"
    // mean the same word. The subquery form keeps the comparison honest
    // without the round trip through `text` that array-level lowering needs.
    if (tags.length) {
      clauses.push(
        `EXISTS (SELECT 1 FROM unnest("p"."tags") AS "__tag"("value")
           WHERE lower(trim("__tag"."value")) = ANY(:interestTags))`,
      );
      qb.setParameter('interestTags', tags);
    }
    if (professions.length) {
      clauses.push(
        `EXISTS (SELECT 1 FROM unnest("p"."profession" || "p"."discipline") AS "__work"("value")
           WHERE lower(trim("__work"."value")) = ANY(:interestProfessions))`,
      );
      qb.setParameter('interestProfessions', professions);
    }
    const rows = await qb
      .where(`(${clauses.join(' OR ')})`)
      // Newest first, so the bounded scan is deterministic rather than
      // whatever order Postgres happens to return.
      .orderBy('"p"."joined_at"', 'DESC')
      .limit(MAX_INTEREST_MATCHES)
      .getRawMany<{ user_id: string }>();
    return new Set(rows.map((row) => row.user_id));
  }

  /**
   * The candidate pool, narrowed to people this viewer is allowed to be shown.
   *
   * The first four gates are the member directory's, reused from the same two
   * services and in the same order as `ProfilesService.searchMembers`, so a
   * suggestion can never surface someone the directory would hide. The last
   * two are this endpoint's own.
   */
  private async visibleCandidates(
    viewerUserId: string,
    candidateIds: string[],
  ): Promise<Profile[]> {
    const bounded = candidateIds.slice(0, MAX_CANDIDATES);
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .where('p.userId IN (:...candidateIds)', { candidateIds: bounded })
      .andWhere('p.userId <> :viewerUserId', { viewerUserId });
    // Blocked in either direction, and muted by the viewer. A suggestion is a
    // content list like any other, so it takes the pair rather than the block
    // half alone.
    this.blockFilter.excludeHidden(qb, viewerUserId, '"p"."user_id"');
    // A candidate who hid THEIR profile from this viewer never surfaces.
    this.hiddenFrom.excludeHiddenFrom(qb, viewerUserId, '"p"."user_id"');
    // "Hide me for 24 hours" removes a member from every viewer's directory
    // results; it must remove them from every viewer's suggestions too.
    qb.andWhere('("p"."hidden_until" IS NULL OR "p"."hidden_until" <= now())');
    // Any connection row at all, in either direction and at any status: see
    // the class docstring on why declined and blocked count.
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "connections" "__suggestion_connection"
        WHERE ("__suggestion_connection"."requester_id" = :suggestionViewerId AND "__suggestion_connection"."addressee_id" = "p"."user_id")
           OR ("__suggestion_connection"."addressee_id" = :suggestionViewerId AND "__suggestion_connection"."requester_id" = "p"."user_id")
      )`,
      { suggestionViewerId: viewerUserId },
    );
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "member_suggestion_dismissals" "__suggestion_dismissal"
        WHERE "__suggestion_dismissal"."user_id" = :suggestionViewerId
          AND "__suggestion_dismissal"."dismissed_user_id" = "p"."user_id"
      )`,
      { suggestionViewerId: viewerUserId },
    );
    // PRD-16: anyone who asked to stop being recommended to strangers.
    //
    // IN THE QUERY, on purpose. Scoring an opted-out member and dropping them
    // afterwards would leave a code path where a mapping change could leak
    // them, and the whole point of the switch is that it cannot be worked
    // around from another surface. Here they are never a candidate at all.
    //
    // `NOT EXISTS` rather than a join, so the ABSENT ROW resolves correctly:
    // a member who has never opened Settings has no `member_preferences` row,
    // `PreferencesService` synthesises the defaults for them, and the default
    // is recommendable. An inner join would have silently excluded every
    // member who never touched a setting, which is most of them.
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "member_preferences" "__suggestion_optout"
        WHERE "__suggestion_optout"."user_id" = "p"."user_id"
          AND "__suggestion_optout"."hide_from_suggestions" = true
      )`,
    );
    return qb.getMany();
  }

  /**
   * Drops anyone a moderator has hidden or removed.
   *
   * Post-query rather than in-query, and that is fine here: this endpoint
   * fetches a bounded pool and then takes its top few, so there is no `LIMIT`
   * to under-fill. A member can be reported under either their slug or their
   * user id, so both keys are checked, matching `ProfilesService`.
   */
  private async dropTakenDown(candidates: Profile[]): Promise<Profile[]> {
    if (!candidates.length) {
      return candidates;
    }
    const subjectIds = candidates.flatMap((profile) => [
      profile.slug,
      profile.userId,
    ]);
    const states = await this.contentModeration.statesForAnyType(
      [MEMBER_SUBJECT_TYPE],
      subjectIds,
    );
    if (!states.size) {
      return candidates;
    }
    return candidates.filter((profile) => {
      const bySlug = states.get(profile.slug);
      const byUserId = states.get(profile.userId);
      const isTakenDown = [bySlug, byUserId].some(
        (state) => !!state && (state.hidden || state.removed),
      );
      return !isTakenDown;
    });
  }
}

/** Trimmed, lower-cased, empties dropped — the comparison form the scoring
 *  module expects on the viewer's side. */
function toComparableSet(values: string[] | null | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}
