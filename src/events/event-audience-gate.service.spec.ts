import { NotFoundException } from '@nestjs/common';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventVisibility } from './entities/event.entity';

function build() {
  const invites = {
    exists: jest.fn().mockResolvedValue(false),
    find: jest.fn().mockResolvedValue([]),
  };
  const rsvps = {
    exists: jest.fn().mockResolvedValue(false),
    find: jest.fn().mockResolvedValue([]),
  };
  const cohosts = {
    find: jest.fn().mockResolvedValue([]),
  };
  const connectionsService = {
    areConnected: jest.fn().mockResolvedValue(false),
    mutualCountsByUserIds: jest.fn().mockResolvedValue(new Map()),
    allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
  };
  const membership = {
    isMember: jest.fn().mockResolvedValue(false),
    communityIdsForUser: jest.fn().mockResolvedValue([]),
  };
  const service = new EventAudienceGateService(
    invites as never,
    rsvps as never,
    cohosts as never,
    connectionsService as never,
    membership as never,
  );
  return { service, invites, rsvps, cohosts, connectionsService, membership };
}

const HOST_ID = 'host-1';
const VIEWER_ID = 'viewer-1';
const EVENT_ID = 'event-1';

function baseEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: EVENT_ID,
    hostId: HOST_ID,
    communityId: null,
    visibility: EventVisibility.Public,
    ...overrides,
  } as never;
}

describe('EventAudienceGateService', () => {
  describe('assertViewable', () => {
    it('admits an organizer unconditionally, for every tier, without querying anything', async () => {
      const { service, invites, rsvps, connectionsService, membership } =
        build();
      const event = baseEvent({ visibility: EventVisibility.InviteOnly });

      await expect(
        service.assertViewable(event, VIEWER_ID, true),
      ).resolves.toBeUndefined();

      expect(invites.exists).not.toHaveBeenCalled();
      expect(rsvps.exists).not.toHaveBeenCalled();
      expect(connectionsService.areConnected).not.toHaveBeenCalled();
      expect(membership.isMember).not.toHaveBeenCalled();
    });

    it('public/members admit a non-organizer without querying anything', async () => {
      const { service, invites, connectionsService, membership } = build();
      const event = baseEvent({ visibility: EventVisibility.Members });

      await expect(
        service.assertViewable(event, VIEWER_ID, false),
      ).resolves.toBeUndefined();
      expect(invites.exists).not.toHaveBeenCalled();
      expect(connectionsService.areConnected).not.toHaveBeenCalled();
      expect(membership.isMember).not.toHaveBeenCalled();
    });

    describe('invite_only', () => {
      const event = baseEvent({ visibility: EventVisibility.InviteOnly });

      it('admits an invited non-organizer', async () => {
        const { service, invites } = build();
        invites.exists.mockResolvedValue(true);
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).resolves.toBeUndefined();
      });

      it('admits a non-organizer with a live (non-cancelled) RSVP even without a formal invite', async () => {
        const { service, rsvps } = build();
        rsvps.exists.mockResolvedValue(true);
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).resolves.toBeUndefined();
      });

      it("rejects (404) a non-organizer who is neither invited nor RSVP'd", async () => {
        const { service } = build();
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('network', () => {
      const event = baseEvent({ visibility: EventVisibility.Network });

      it('admits a non-organizer directly connected to the host', async () => {
        const { service, connectionsService } = build();
        connectionsService.areConnected.mockResolvedValue(true);
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).resolves.toBeUndefined();
      });

      it('rejects (404) a non-organizer not connected to the host', async () => {
        const { service } = build();
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('extended_network', () => {
      const event = baseEvent({ visibility: EventVisibility.ExtendedNetwork });

      it('admits a directly-connected non-organizer without needing the mutual-count query', async () => {
        const { service, connectionsService } = build();
        connectionsService.areConnected.mockResolvedValue(true);
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).resolves.toBeUndefined();
        expect(connectionsService.mutualCountsByUserIds).not.toHaveBeenCalled();
      });

      it('admits a 2nd-degree (mutual-only) non-organizer', async () => {
        const { service, connectionsService } = build();
        connectionsService.areConnected.mockResolvedValue(false);
        connectionsService.mutualCountsByUserIds.mockResolvedValue(
          new Map([[HOST_ID, 2]]),
        );
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).resolves.toBeUndefined();
      });

      it('rejects (404) a non-organizer with no direct or mutual connection', async () => {
        const { service } = build();
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('community', () => {
      const event = baseEvent({
        visibility: EventVisibility.Community,
        communityId: 'community-1',
      });

      it('admits a non-organizer roster member', async () => {
        const { service, membership } = build();
        membership.isMember.mockResolvedValue(true);
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).resolves.toBeUndefined();
      });

      it('rejects (404) a non-organizer non-member', async () => {
        const { service } = build();
        await expect(
          service.assertViewable(event, VIEWER_ID, false),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  describe('filterViewable', () => {
    it('returns [] immediately for an empty page, without querying anything', async () => {
      const { service, cohosts, invites, connectionsService, membership } =
        build();
      await expect(service.filterViewable([], VIEWER_ID)).resolves.toEqual([]);
      expect(cohosts.find).not.toHaveBeenCalled();
      expect(invites.find).not.toHaveBeenCalled();
      expect(
        connectionsService.allAcceptedConnectionUserIds,
      ).not.toHaveBeenCalled();
      expect(membership.communityIdsForUser).not.toHaveBeenCalled();
    });

    // The five cases fix round 2's `scopedVisibilityWhere`-based filter
    // wrongly dropped from a viewer's saved list — each must now appear.
    it("case 1: an invited (non-organizer) member's bookmarked invite_only event appears", async () => {
      const { service, invites } = build();
      const event = baseEvent({
        id: 'invite-only-event',
        visibility: EventVisibility.InviteOnly,
      });
      invites.find.mockResolvedValue([{ eventId: 'invite-only-event' }]);

      const result = await service.filterViewable([event], VIEWER_ID);
      expect(result).toEqual([event]);
    });

    it("case 2: a 2nd-degree (mutual-only) member's bookmarked extended_network event appears", async () => {
      const { service, connectionsService } = build();
      const event = baseEvent({
        id: 'extended-network-event',
        visibility: EventVisibility.ExtendedNetwork,
      });
      connectionsService.allAcceptedConnectionUserIds.mockResolvedValue([]); // not directly connected
      connectionsService.mutualCountsByUserIds.mockResolvedValue(
        new Map([[HOST_ID, 1]]),
      );

      const result = await service.filterViewable([event], VIEWER_ID);
      expect(result).toEqual([event]);
    });

    it("case 3: an organizer's own bookmarked network event appears (nobody is connected to themselves)", async () => {
      const { service, connectionsService } = build();
      const event = baseEvent({
        id: 'my-network-event',
        hostId: VIEWER_ID, // viewer IS the host
        visibility: EventVisibility.Network,
      });

      const result = await service.filterViewable([event], VIEWER_ID);
      expect(result).toEqual([event]);
      // Organizer bypass short-circuits before any connection lookup is
      // even needed for THIS event.
      expect(
        connectionsService.allAcceptedConnectionUserIds,
      ).not.toHaveBeenCalled();
    });

    it("case 4: an organizer's own community event appears even after leaving that community", async () => {
      const { service, membership } = build();
      const event = baseEvent({
        id: 'my-old-community-event',
        hostId: VIEWER_ID,
        visibility: EventVisibility.Community,
        communityId: 'community-1',
      });
      membership.communityIdsForUser.mockResolvedValue([]); // no longer a member of anything

      const result = await service.filterViewable([event], VIEWER_ID);
      expect(result).toEqual([event]);
    });

    it("case 5: an organizer's own invite_only/extended_network event appears", async () => {
      const { service } = build();
      const inviteOnly = baseEvent({
        id: 'my-invite-only-event',
        hostId: VIEWER_ID,
        visibility: EventVisibility.InviteOnly,
      });
      const extendedNetwork = baseEvent({
        id: 'my-extended-network-event',
        hostId: VIEWER_ID,
        visibility: EventVisibility.ExtendedNetwork,
      });

      const result = await service.filterViewable(
        [inviteOnly, extendedNetwork],
        VIEWER_ID,
      );
      expect(result).toEqual([inviteOnly, extendedNetwork]);
    });

    it('still excludes a stranger with no connection/membership/invite from any scoped tier (no over-correction)', async () => {
      const { service } = build();
      const events = [
        baseEvent({ id: 'e-invite', visibility: EventVisibility.InviteOnly }),
        baseEvent({ id: 'e-network', visibility: EventVisibility.Network }),
        baseEvent({
          id: 'e-extended',
          visibility: EventVisibility.ExtendedNetwork,
        }),
        baseEvent({
          id: 'e-community',
          visibility: EventVisibility.Community,
          communityId: 'community-1',
        }),
      ];

      const result = await service.filterViewable(events, VIEWER_ID);
      expect(result).toEqual([]);
    });

    it('keeps public/members events for everyone without any per-tier query', async () => {
      const { service, invites, connectionsService, membership } = build();
      const events = [
        baseEvent({ id: 'e-public', visibility: EventVisibility.Public }),
        baseEvent({ id: 'e-members', visibility: EventVisibility.Members }),
      ];

      const result = await service.filterViewable(events, VIEWER_ID);
      expect(result).toEqual(events);
      expect(invites.find).not.toHaveBeenCalled();
      expect(
        connectionsService.allAcceptedConnectionUserIds,
      ).not.toHaveBeenCalled();
      expect(membership.communityIdsForUser).not.toHaveBeenCalled();
    });

    it('batches the co-host lookup ONCE for the whole page (no N+1)', async () => {
      const { service, cohosts } = build();
      const events = [
        baseEvent({ id: 'e1', visibility: EventVisibility.Public }),
        baseEvent({ id: 'e2', visibility: EventVisibility.Members }),
        baseEvent({ id: 'e3', visibility: EventVisibility.Public }),
      ];

      await service.filterViewable(events, VIEWER_ID);

      expect(cohosts.find).toHaveBeenCalledTimes(1);
      expect(cohosts.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: VIEWER_ID }),
        }),
      );
    });

    it('batches the mutual-count lookup to only the extended_network host ids still needing it', async () => {
      const { service, connectionsService } = build();
      connectionsService.allAcceptedConnectionUserIds.mockResolvedValue([
        'already-connected-host',
      ]);
      const events = [
        baseEvent({
          id: 'e1',
          hostId: 'already-connected-host',
          visibility: EventVisibility.ExtendedNetwork,
        }),
        baseEvent({
          id: 'e2',
          hostId: 'needs-mutual-check-host',
          visibility: EventVisibility.ExtendedNetwork,
        }),
      ];

      await service.filterViewable(events, VIEWER_ID);

      expect(connectionsService.mutualCountsByUserIds).toHaveBeenCalledWith(
        VIEWER_ID,
        ['needs-mutual-check-host'],
      );
    });
  });
});
