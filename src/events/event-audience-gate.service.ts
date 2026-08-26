import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { CommunityMembershipService } from '../communities/community-membership.service';
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
   *  - community: the viewer's own community-membership id-set, fetched
   *    once.
   *
   * Any of the five preload queries is skipped entirely if nothing in the
   * page needs it (e.g. a saved list with no `community` events never calls
   * `communityIdsForUser`).
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
      ? new Set(await this.membership.communityIdsForUser(viewerId))
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

  // --- internals ---

  /**
   * The shared per-tier decision, pure and synchronous — no queries, just
   * `event.visibility` + the pre-loaded `context`. This is the single source
   * of truth both `assertViewable` (throw-on-false) and `filterViewable`
   * (keep-on-true) evaluate against, so the tier logic itself can never
   * drift between a "check one" and "filter many" caller.
   */
  private isViewable(event: Event, context: ViewabilityContext): boolean {
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
   * additionally qualify when the viewer's OWN id-sets admit them — a host
   * the viewer is connected to, or a community the viewer is on the roster
   * of — computed ONCE per call, not per row.
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
      this.membership.communityIdsForUser(viewerId),
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
    return { clause: `(${clauses.join(' OR ')})`, params };
  }
}
