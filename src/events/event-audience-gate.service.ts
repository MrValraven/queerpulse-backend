import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { resolveEffectiveRole } from '../communities/subcommunity-rules';
import { ConnectionsService } from '../connections/connections.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventVisibility } from './entities/event.entity';

/**
 * The per-event facts `isViewable` needs to decide one event's tier —
 * pre-computed by the caller (either a single-event targeted lookup in
 * `assertViewable`, or one batched pass over a whole page in
 * `filterViewable`), never queried inside `isViewable` itself. This is what
 * makes the same decision function usable for both a single live check and a
 * zero-N+1 page filter.
 */
interface ViewabilityContext {
  isOrganizer: boolean;
  isInvited: boolean;
  hasLiveRsvp: boolean;
  isConnectedToHost: boolean;
  hasMutualConnectionWithHost: boolean;
  isCommunityMember: boolean;
}

const NO_SIGNAL: Omit<ViewabilityContext, 'isOrganizer'> = {
  isInvited: false,
  hasLiveRsvp: false,
  isConnectedToHost: false,
  hasMutualConnectionWithHost: false,
  isCommunityMember: false,
};

/** The event fields `audienceAmong` reads. */
export type EventAudienceSubject = Pick<
  Event,
  'id' | 'hostId' | 'visibility' | 'communityId'
>;

/**
 * Who among a candidate set organizes one event, and who passes its audience
 * tier (organizers included). Returned by `audienceAmong`.
 */
export interface EventAudienceAmong {
  organizerUserIds: Set<string>;
  viewerUserIds: Set<string>;
}

/**
 * The gathering-audience-scope tier check — the single source of truth for
 * "who can see this event's content", shared by `EventsService.assertCanView`
 * (detail reads), `RsvpService`'s RSVP gate (writes), and
 * `EventBookmarksService` (bookmark writes + the "saved" list read, fix
 * round 3). The 2026-08-13 design doc's table is one column,
 * "Who can view / RSVP", not two separate rules — before this service
 * existed, `RsvpService` never ran this check at all, so a member with a
 * guessable slug could POST an RSVP to a `network`/`extended_network`/
 * `community` gathering they could not even view (fixed 2026-08-13, fix
 * round 1).
 *
 * Deliberately narrow: only the four SCOPED tiers (`invite_only`, `network`,
 * `extended_network`, `community`) are checked here. `public`/`members`
 * admit everyone and fall through. Draft-workspace visibility and moderator
 * takedown are NOT this service's concern — those are caller-specific
 * (`assertCanView` applies them itself; the RSVP path already separately
 * rejects non-`published` events before this runs) and don't belong on a
 * write-path gate the same way a read-path existence-hiding rule does.
 *
 * Every rejection throws `NotFoundException` (never `Forbidden`) so a
 * gathering's existence is never leaked to someone outside its audience —
 * matching `assertCanView`'s existing "don't leak existence" posture. This is
 * an intentional behavior change for the RSVP path's prior `invite_only`
 * rejection, which threw `ForbiddenException('This event is invite-only')`;
 * unifying on one shared method means unifying on one exception shape too.
 */
@Injectable()
export class EventAudienceGateService {
  constructor(
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    private readonly connectionsService: ConnectionsService,
    private readonly membership: CommunityMembershipService,
    // Read by `audienceAmong` alone: one roster read answers the `community`
    // tier for a whole candidate set, by the same effective-role rule
    // `CommunityMembershipService.isMember` applies to one viewer.
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
  ) {}

  /**
   * Throws `NotFoundException('Event not found')` when `viewerId` fails the
   * event's own audience-scope tier. `isOrganizer` is passed in (not
   * recomputed here) because every caller already needs it for its own
   * purposes (view: to decide whether to run the moderation/draft checks at
   * all; RSVP/bookmark: the host/co-host bypass) — organizers always pass,
   * for every tier, without needing the tier's own predicate evaluated at
   * all.
   *
   * Behavior is UNCHANGED from before fix round 3: this now just builds a
   * `ViewabilityContext` with exactly the same targeted, tier-scoped queries
   * the old inline branches ran (organizer short-circuits before any query;
   * only the event's own tier's fields get queried), then hands off to the
   * shared `isViewable` predicate — same decision, same exception, same
   * short-circuiting, split into "gather the facts" / "decide" instead of
   * one interleaved function.
   */
  async assertViewable(
    event: Event,
    viewerId: string,
    isOrganizer: boolean,
  ): Promise<void> {
    const context = await this.buildContextForOne(event, viewerId, isOrganizer);
    if (!this.isViewable(event, context)) {
      throw new NotFoundException('Event not found');
    }
  }

  /**
   * Filters `events` down to exactly the ones `viewerId` can currently
   * VIEW — the same per-event decision `assertViewable` throws on, applied
   * to a whole page at once. Backs `EventBookmarksService.listSaved` (fix
   * round 3): a saved list must reflect full per-event viewability
   * (organizer bypass, invite_only, extended_network — everything
   * `assertViewable` checks), NOT the cheaper `scopedVisibilityWhere`
   * browse-discovery predicate, which has no invite_only branch, no
   * extended_network branch, and no organizer bypass, and so wrongly hid an
   * invited member's own bookmarked invite_only event, a 2nd-degree
   * viewer's bookmarked extended_network event, and every organizer's OWN
   * bookmarked network/community/invite_only/extended_network event
   * (nobody is "connected to themselves", and an organizer can outlive their
   * own community membership). "What can I discover" and "what have I
   * already saved that I can still see" are different questions with
   * different answers.
   *
   * ZERO per-event queries: every piece of context every tier could need is
   * preloaded ONCE for the whole batch (mirrors how `EventsService
   * .buildDetail` batches its own per-event lookups):
   *  - organizer status: host id compare (free) + one batched co-host
   *    lookup (`eventId IN (...)`),
   *  - invite_only membership: one batched `event_invites` lookup + one
   *    batched live-RSVP lookup, each scoped to just the page's non-organizer
   *    invite_only event ids,
   *  - network/extended_network: the viewer's own UNCAPPED accepted-
   *    connection id-set, fetched once and reused for every event needing it,
   *  - extended_network's mutual-connection fallback: one batched
   *    `mutualCountsByUserIds` call over exactly the host ids that still need
   *    it (i.e. not already directly connected),
   *  - community: the ids of every community the viewer holds an effective
   *    role in, fetched once (`effectiveCommunityIdsForUser`: their own
   *    roster rows, a space row only under a parent row, plus every space
   *    under a parent where they are owner, co-owner or mod), the same set
   *    `isMember` admits one community at a time.
   *
   * Any of the five preload queries is skipped entirely if nothing in the
   * page needs it (e.g. a saved list with no `community` events never calls
   * `effectiveCommunityIdsForUser`).
   *
   * Post-fetch filtering means a page can come back SHORTER than the
   * requested `take` when some bookmarks are no longer viewable — accepted
   * for a user-scoped saved list (see `EventBookmarksService.listSaved`'s own
   * doc for the pagination-shape note); this method doesn't paginate, it
   * only filters what it's given.
   */
  async filterViewable(events: Event[], viewerId: string): Promise<Event[]> {
    if (events.length === 0) return [];

    const eventIds = events.map((event) => event.id);
    const cohostRows = await this.cohosts.find({
      where: { userId: viewerId, eventId: In(eventIds) },
      select: { eventId: true },
    });
    const cohostEventIds = new Set(cohostRows.map((row) => row.eventId));
    const isOrganizerFor = (event: Event): boolean =>
      event.hostId === viewerId || cohostEventIds.has(event.id);

    // Only non-organizer events actually need their tier's facts gathered —
    // an organizer passes unconditionally, same as `assertViewable`.
    const needsTierCheck = (event: Event): boolean => !isOrganizerFor(event);

    const inviteOnlyEventIds = events
      .filter(
        (event) =>
          event.visibility === EventVisibility.InviteOnly &&
          needsTierCheck(event),
      )
      .map((event) => event.id);
    const [invitedRows, rsvpedRows] = await Promise.all([
      inviteOnlyEventIds.length
        ? this.invites.find({
            where: { inviteeId: viewerId, eventId: In(inviteOnlyEventIds) },
            select: { eventId: true },
          })
        : Promise.resolve([]),
      inviteOnlyEventIds.length
        ? this.rsvps.find({
            where: {
              userId: viewerId,
              eventId: In(inviteOnlyEventIds),
              status: Not(RsvpStatus.Cancelled),
            },
            select: { eventId: true },
          })
        : Promise.resolve([]),
    ]);
    const invitedEventIds = new Set(invitedRows.map((row) => row.eventId));
    const rsvpedEventIds = new Set(rsvpedRows.map((row) => row.eventId));

    const needsConnections = events.some(
      (event) =>
        needsTierCheck(event) &&
        (event.visibility === EventVisibility.Network ||
          event.visibility === EventVisibility.ExtendedNetwork),
    );
    const viewerConnectionIds = needsConnections
      ? new Set(
          await this.connectionsService.allAcceptedConnectionUserIds(viewerId),
        )
      : new Set<string>();

    // `hostId` is NULL once the host's account is erased
    // (`SetNullContentAuthorFksOnUserErasure1794610000000`). There is no
    // network relationship to an erased member, so a NULL host is filtered
    // out here and reads as "not connected, no mutuals" below. That keeps a
    // network-only gathering closed rather than letting an erased host
    // quietly widen its audience.
    const extendedNetworkHostIdsNeedingMutualCheck = presentActorIds([
      ...new Set(
        events
          .filter(
            (event) =>
              needsTierCheck(event) &&
              event.visibility === EventVisibility.ExtendedNetwork &&
              event.hostId !== null &&
              !viewerConnectionIds.has(event.hostId),
          )
          .map((event) => event.hostId),
      ),
    ]);
    const mutualCounts = extendedNetworkHostIdsNeedingMutualCheck.length
      ? await this.connectionsService.mutualCountsByUserIds(
          viewerId,
          extendedNetworkHostIdsNeedingMutualCheck,
        )
      : new Map<string, number>();

    const needsCommunity = events.some(
      (event) =>
        needsTierCheck(event) && event.visibility === EventVisibility.Community,
    );
    const viewerCommunityIds = needsCommunity
      ? new Set(await this.membership.effectiveCommunityIdsForUser(viewerId))
      : new Set<string>();

    return events.filter((event) => {
      const isOrganizer = isOrganizerFor(event);
      const context: ViewabilityContext = isOrganizer
        ? { isOrganizer: true, ...NO_SIGNAL }
        : {
            isOrganizer: false,
            isInvited: invitedEventIds.has(event.id),
            hasLiveRsvp: rsvpedEventIds.has(event.id),
            isConnectedToHost:
              event.hostId !== null && viewerConnectionIds.has(event.hostId),
            hasMutualConnectionWithHost:
              (actorFromLookup(mutualCounts, event.hostId) ?? 0) > 0,
            isCommunityMember:
              event.communityId !== null &&
              viewerCommunityIds.has(event.communityId),
          };
      return this.isViewable(event, context);
    });
  }

  /**
   * The many-viewers form of `assertViewable`: for ONE event, which of
   * `candidateUserIds` organize it (host or co-host) and which pass its
   * audience tier, organizers included. Backs the mention fan-out of a
   * gathering's description (`MentionNotificationService`), which has to
   * hold every tagged member to the audience the detail page admits.
   *
   * The same `isViewable` decision as the other two entry points, with every
   * fact preloaded once for the whole candidate set, so the cost does not
   * grow with the number of candidates:
   *  - organizers: the host id compare plus one co-host read;
   *  - `invite_only`: one invite read and one live-RSVP read;
   *  - `network`: one read of the host's connections among the candidates;
   *  - `extended_network`: that read, plus one mutual-connection count over
   *    the candidates it left out (a mutual connection is symmetric, so
   *    counting from the host's side answers the viewer's question);
   *  - `community`: the community row plus one roster read covering the
   *    parent too when it is a space.
   * Only the event's own tier is read, and only for non-organizers.
   *
   * Draft workspace and moderator takedown stay with the caller, exactly as
   * for `assertViewable`: the caller narrows to `organizerUserIds` when
   * either applies.
   */
  async audienceAmong(
    event: EventAudienceSubject,
    candidateUserIds: string[],
  ): Promise<EventAudienceAmong> {
    const candidates = [...new Set(candidateUserIds)];
    if (!candidates.length) {
      return { organizerUserIds: new Set(), viewerUserIds: new Set() };
    }
    const cohostRows = await this.cohosts.find({
      where: { eventId: event.id, userId: In(candidates) },
      select: { userId: true },
    });
    const organizerUserIds = new Set(cohostRows.map((row) => row.userId));
    if (event.hostId !== null && candidates.includes(event.hostId)) {
      organizerUserIds.add(event.hostId);
    }
    const tierCandidates = candidates.filter(
      (userId) => !organizerUserIds.has(userId),
    );
    const contextByUserId = await this.buildContextsForCandidates(
      event,
      tierCandidates,
    );
    const viewerUserIds = new Set(organizerUserIds);
    for (const userId of tierCandidates) {
      const context = contextByUserId.get(userId) ?? {
        isOrganizer: false,
        ...NO_SIGNAL,
      };
      if (this.isViewable(event, context)) viewerUserIds.add(userId);
    }
    return { organizerUserIds, viewerUserIds };
  }

  // --- internals ---

  /**
   * The `ViewabilityContext` of each non-organizer in `candidateUserIds` for
   * one event, reading only the facts the event's own tier needs (see
   * `audienceAmong`). A candidate with no signal is absent from the map.
   */
  private async buildContextsForCandidates(
    event: EventAudienceSubject,
    candidateUserIds: string[],
  ): Promise<Map<string, ViewabilityContext>> {
    const contextByUserId = new Map<string, ViewabilityContext>();
    if (!candidateUserIds.length) return contextByUserId;
    const withSignal = (
      userIds: Iterable<string>,
      signal: Partial<Omit<ViewabilityContext, 'isOrganizer'>>,
    ): void => {
      for (const userId of userIds) {
        contextByUserId.set(userId, {
          isOrganizer: false,
          ...NO_SIGNAL,
          ...contextByUserId.get(userId),
          ...signal,
        });
      }
    };

    switch (event.visibility) {
      case EventVisibility.InviteOnly: {
        const [invitedRows, rsvpedRows] = await Promise.all([
          this.invites.find({
            where: { eventId: event.id, inviteeId: In(candidateUserIds) },
            select: { inviteeId: true },
          }),
          this.rsvps.find({
            where: {
              eventId: event.id,
              userId: In(candidateUserIds),
              status: Not(RsvpStatus.Cancelled),
            },
            select: { userId: true },
          }),
        ]);
        withSignal(
          invitedRows.map((row) => row.inviteeId),
          { isInvited: true },
        );
        withSignal(
          rsvpedRows.map((row) => row.userId),
          { hasLiveRsvp: true },
        );
        return contextByUserId;
      }
      case EventVisibility.Network:
      case EventVisibility.ExtendedNetwork: {
        // An erased host (NULL `hostId`) has no connections, so both network
        // tiers stay closed, as in `buildContextForOne`.
        const hostId = event.hostId;
        if (hostId === null) return contextByUserId;
        const connectedUserIds =
          await this.connectionsService.acceptedConnectionsAmong(
            hostId,
            candidateUserIds,
          );
        withSignal(connectedUserIds, { isConnectedToHost: true });
        if (event.visibility === EventVisibility.Network) {
          return contextByUserId;
        }
        const unconnectedUserIds = candidateUserIds.filter(
          (userId) => !connectedUserIds.has(userId),
        );
        const mutualCounts = unconnectedUserIds.length
          ? await this.connectionsService.mutualCountsByUserIds(
              hostId,
              unconnectedUserIds,
            )
          : new Map<string, number>();
        withSignal(
          unconnectedUserIds.filter(
            (userId) => (mutualCounts.get(userId) ?? 0) > 0,
          ),
          { hasMutualConnectionWithHost: true },
        );
        return contextByUserId;
      }
      case EventVisibility.Community: {
        if (event.communityId === null) return contextByUserId;
        withSignal(
          await this.communityMembersAmong(event.communityId, candidateUserIds),
          { isCommunityMember: true },
        );
        return contextByUserId;
      }
      default:
        // `public` / `members` admit everyone; nothing to read.
        return contextByUserId;
    }
  }

  /**
   * The subset of `candidateUserIds` holding an effective role in
   * `communityId`: `CommunityMembershipService.isMember` for a whole set, by
   * the same `resolveEffectiveRole` rule (a top-level roster row; inside a
   * space, a space row under a parent row, or parent staff standing). An
   * unknown community admits nobody, as `isMember` answers false for it.
   */
  private async communityMembersAmong(
    communityId: string,
    candidateUserIds: string[],
  ): Promise<string[]> {
    const community = await this.communities.findOne({
      where: { id: communityId },
      select: { id: true, parentId: true },
    });
    if (!community) return [];
    const parentId = community.parentId ?? null;
    const rosterRows = await this.communityMembers.find({
      where: {
        communityId: parentId ? In([community.id, parentId]) : community.id,
        userId: In(candidateUserIds),
      },
      select: { userId: true, communityId: true, role: true },
    });
    return candidateUserIds.filter((userId) => {
      const ownRow = rosterRows.find(
        (row) => row.userId === userId && row.communityId === community.id,
      );
      const parentRow = parentId
        ? rosterRows.find(
            (row) => row.userId === userId && row.communityId === parentId,
          )
        : undefined;
      return (
        resolveEffectiveRole({
          isSpace: parentId !== null,
          ownRole: ownRow?.role ?? null,
          parentRole: parentRow?.role ?? null,
        }) !== null
      );
    });
  }

  /**
   * The shared per-tier decision, pure and synchronous — no queries, just
   * `event.visibility` + the pre-loaded `context`. This is the single source
   * of truth both `assertViewable` (throw-on-false) and `filterViewable`
   * (keep-on-true) evaluate against, so the tier logic itself can never
   * drift between a "check one" and "filter many" caller.
   */
  private isViewable(
    event: Pick<Event, 'visibility'>,
    context: ViewabilityContext,
  ): boolean {
    if (context.isOrganizer) return true;

    switch (event.visibility) {
      case EventVisibility.InviteOnly:
        // Visible to organizers (handled above), invited members, and anyone
        // who already has a live (non-cancelled) RSVP — e.g. an invite later
        // revoked after the member already joined.
        return context.isInvited || context.hasLiveRsvp;
      case EventVisibility.Network:
        // Strict 1st degree: the host's own accepted connections.
        return context.isConnectedToHost;
      case EventVisibility.ExtendedNetwork:
        // 2nd degree: the `Network` condition above, OR a shared (mutual)
        // accepted connection between viewer and host. This generalizes
        // `resolveRequestGate`'s profile-`network` graph test (which checks
        // one NAMED introducer against both parties) to "does ANY mutual
        // connection exist" — same underlying accepted-connections graph and
        // the same `ConnectionsService` helpers, not a re-derivation of the
        // math, but not literally the same test either.
        return context.isConnectedToHost || context.hasMutualConnectionWithHost;
      case EventVisibility.Community:
        // `event.communityId` is guaranteed non-null here whenever this tier
        // is reachable — `create`/`update` reject `Community` visibility
        // with no community attached (400). `context.isCommunityMember`
        // already folds in the null-check where it's computed.
        return context.isCommunityMember;
      default:
        // `public` / `members` — no tier predicate, everyone admitted.
        return true;
    }
  }

  /**
   * Builds the `ViewabilityContext` for exactly ONE event, via the same
   * targeted, tier-scoped queries `assertViewable`'s old inline branches ran
   * — an organizer short-circuits before any query; every other case only
   * queries the fields its OWN tier needs (an invite_only event never
   * touches `ConnectionsService`, a `network` event never touches
   * `event_invites`, etc.). This preserves `assertViewable`'s exact prior
   * query shape/cost; `filterViewable` above takes the batched path instead
   * of calling this per event.
   */
  private async buildContextForOne(
    event: Event,
    viewerId: string,
    isOrganizer: boolean,
  ): Promise<ViewabilityContext> {
    if (isOrganizer) {
      return { isOrganizer: true, ...NO_SIGNAL };
    }

    switch (event.visibility) {
      case EventVisibility.InviteOnly: {
        const [invited, rsvped] = await Promise.all([
          this.invites.exists({
            where: { eventId: event.id, inviteeId: viewerId },
          }),
          this.rsvps.exists({
            where: {
              eventId: event.id,
              userId: viewerId,
              status: Not(RsvpStatus.Cancelled),
            },
          }),
        ]);
        return {
          isOrganizer: false,
          ...NO_SIGNAL,
          isInvited: invited,
          hasLiveRsvp: rsvped,
        };
      }
      case EventVisibility.Network: {
        // An erased host (NULL `hostId`) has no connections, so the tier
        // stays closed rather than opening up.
        const connected =
          event.hostId !== null &&
          (await this.connectionsService.areConnected(viewerId, event.hostId));
        return {
          isOrganizer: false,
          ...NO_SIGNAL,
          isConnectedToHost: connected,
        };
      }
      case EventVisibility.ExtendedNetwork: {
        const hostId = event.hostId;
        const connected =
          hostId !== null &&
          (await this.connectionsService.areConnected(viewerId, hostId));
        let hasMutual = false;
        if (hostId !== null && !connected) {
          const mutualCounts =
            await this.connectionsService.mutualCountsByUserIds(viewerId, [
              hostId,
            ]);
          hasMutual = (mutualCounts.get(hostId) ?? 0) > 0;
        }
        return {
          isOrganizer: false,
          ...NO_SIGNAL,
          isConnectedToHost: connected,
          hasMutualConnectionWithHost: hasMutual,
        };
      }
      case EventVisibility.Community: {
        const isMember =
          event.communityId !== null &&
          (await this.membership.isMember(event.communityId, viewerId));
        return {
          isOrganizer: false,
          ...NO_SIGNAL,
          isCommunityMember: isMember,
        };
      }
      default:
        // `public` / `members` — `isViewable` returns true regardless of
        // context, so nothing needs to be queried.
        return { isOrganizer: false, ...NO_SIGNAL };
    }
  }

  /**
   * The visibility predicate shared by every gathering BROWSE-DISCOVERY
   * surface: `EventsService.list`'s 'upcoming' branch and
   * `EventsService.searchByText`. NOT used for "saved"/bookmarks anymore
   * (fix round 3) — see `filterViewable` above for why a saved list needs
   * full per-event viewability, not this cheaper discovery predicate.
   *
   * `public`/`members` always qualify. `network`/`community` gatherings
   * additionally qualify when the viewer's OWN id-sets admit them: a host
   * the viewer is connected to, or a community the viewer holds an effective
   * role in (`effectiveCommunityIdsForUser`, the same set `assertViewable`
   * admits for the `community` tier). Both sets are computed ONCE per call.
   *
   * `invite_only` stays excluded (it surfaces only through
   * going/hosting/invited contexts, never an open list).
   *
   * `extended_network` (2nd-degree) ALSO stays excluded here on purpose — see
   * the 2026-08-13 gathering-audience-scope design doc, decision 2b:
   * expanding "connections of my connections" into an id-set on every
   * list request is unbounded, hot-path cost for a tier whose mental model is
   * "someone passed this to me", not "I stumbled on it". It is link-only,
   * reachable through `getBySlug` -> `assertViewable`'s mutual-connection
   * check, exactly like `invite_only`.
   *
   * Guards against empty id-sets: `IN (:...ids)` with a zero-length array is
   * invalid SQL, so each OR branch is only appended when its id-set is
   * non-empty.
   *
   * Uses `allAcceptedConnectionUserIds` (UNCAPPED), not the 200-capped
   * `getAcceptedConnectionUserIds` — this is an internal SQL predicate, not a
   * rendered list, and truncating it would silently hide a `network`-only
   * gathering from a viewer's own 201st+ connection.
   *
   * ALIAS CONTRACT: the returned clause hardcodes the events query-builder
   * alias `e` (`e.visibility`, `e.host_id`, `e.community_id`) — every current
   * caller already aliases its `Event` query builder `'e'`
   * (`.createQueryBuilder('e')`), so this isn't a new constraint, just worth
   * stating: a future caller with a different alias would need its own
   * variant, not a call to this one.
   */
  async scopedVisibilityWhere(
    viewerId: string,
  ): Promise<{ clause: string; params: Record<string, unknown> }> {
    const [viewerConnectionIds, viewerCommunityIds] = await Promise.all([
      this.connectionsService.allAcceptedConnectionUserIds(viewerId),
      this.membership.effectiveCommunityIdsForUser(viewerId),
    ]);

    const clauses = ['e.visibility IN (:...vis)'];
    const params: Record<string, unknown> = {
      vis: [EventVisibility.Public, EventVisibility.Members],
    };
    if (viewerConnectionIds.length > 0) {
      clauses.push(
        '(e.visibility = :networkVisibility AND e.host_id IN (:...viewerConnectionIds))',
      );
      params.networkVisibility = EventVisibility.Network;
      params.viewerConnectionIds = viewerConnectionIds;
    }
    if (viewerCommunityIds.length > 0) {
      clauses.push(
        '(e.visibility = :communityVisibility AND e.community_id IN (:...viewerCommunityIds))',
      );
      params.communityVisibility = EventVisibility.Community;
      params.viewerCommunityIds = viewerCommunityIds;
    }
    // Spaces never appear in Discover. The visibility arms above admit a
    // space's `public`/`members`/`network` gathering to everyone, so every
    // gathering hosted by a space is ANDed down to viewers who stand in that
    // space. `effectiveCommunityIdsForUser` applies the space rules through
    // `resolveEffectiveRole`: a space row counts only with the parent row, and
    // a parent owner, co-owner or mod reaches every space under that parent
    // with no space row of their own. That makes it the right set to admit
    // by. Mirrors the feed's gathering arm.
    const spaceScope =
      viewerCommunityIds.length > 0
        ? ' OR e.community_id IN (:...viewerCommunityIds)'
        : '';
    const spaceClause = `(
      e.community_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "communities" "evc"
        WHERE "evc"."id" = e.community_id
          AND "evc"."parent_id" IS NOT NULL
      )${spaceScope}
    )`;
    return {
      clause: `((${clauses.join(' OR ')}) AND ${spaceClause})`,
      params,
    };
  }
}
