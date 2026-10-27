import { NotFoundException } from '@nestjs/common';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ConnectionsService } from '../connections/connections.service';
import { EventsService } from '../events/events.service';
import { LastActiveService } from './last-active.service';
import { NowInsightsService } from './now-insights.service';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

// `GET /profiles/:slug/events`: the profile gate first, then the limited-card
// rule, and only then the event read.
describe('ProfilesController.getEvents', () => {
  const viewer: CurrentUserData = {
    userId: 'viewer-1',
    email: 'viewer@example.test',
    status: 'active',
    role: 'moderator',
  };
  const target = { userId: 'member-1', slug: 'sam' };

  let controller: ProfilesController;
  let profilesService: {
    findBySlugOrThrow: jest.Mock;
    canViewFull: jest.Mock;
  };
  let eventsService: { listForMemberProfile: jest.Mock };

  // Built directly: a testing module would also have to resolve every guard
  // the controller's other routes declare, which this route does not need.
  beforeEach(() => {
    profilesService = {
      findBySlugOrThrow: jest.fn().mockResolvedValue(target),
      canViewFull: jest.fn().mockResolvedValue(true),
    };
    eventsService = {
      listForMemberProfile: jest.fn().mockResolvedValue({
        upcoming: [{ slug: 'listed-event', role: 'host' }],
        past: [],
      }),
    };
    controller = new ProfilesController(
      profilesService as unknown as ProfilesService,
      {} as ConnectionsService,
      {} as LastActiveService,
      {} as NowInsightsService,
      eventsService as unknown as EventsService,
    );
  });

  it('resolves the profile with the viewer id and role', async () => {
    await controller.getEvents(viewer, 'sam');

    expect(profilesService.findBySlugOrThrow).toHaveBeenCalledWith(
      'sam',
      'viewer-1',
      'moderator',
    );
  });

  it('lets the profile gate 404 through untouched', async () => {
    const notFound = new NotFoundException('Profile not found');
    profilesService.findBySlugOrThrow.mockRejectedValue(notFound);

    await expect(controller.getEvents(viewer, 'gone')).rejects.toBe(notFound);
    expect(profilesService.canViewFull).not.toHaveBeenCalled();
    expect(eventsService.listForMemberProfile).not.toHaveBeenCalled();
  });

  it('answers two empty lists to a viewer held to the limited card', async () => {
    profilesService.canViewFull.mockResolvedValue(false);

    const response = await controller.getEvents(viewer, 'sam');

    expect(response).toEqual({ upcoming: [], past: [] });
    expect(profilesService.canViewFull).toHaveBeenCalledWith(
      target,
      'viewer-1',
    );
    expect(eventsService.listForMemberProfile).not.toHaveBeenCalled();
  });

  it('reads the member events for a viewer who sees the full profile', async () => {
    const response = await controller.getEvents(viewer, 'sam');

    expect(eventsService.listForMemberProfile).toHaveBeenCalledTimes(1);
    expect(eventsService.listForMemberProfile).toHaveBeenCalledWith(
      'member-1',
      'viewer-1',
    );
    expect(response).toEqual({
      upcoming: [{ slug: 'listed-event', role: 'host' }],
      past: [],
    });
  });
});
