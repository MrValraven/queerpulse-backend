import { BadRequestException } from '@nestjs/common';
import { CommunitiesController } from '../communities/communities.controller';
import { EventsController } from '../events/events.controller';

const MEMBER = { userId: 'member-1' } as never;
const DTO = {} as never;

const buildEventsController = (eventsService: object, slots: object) =>
  new EventsController(
    eventsService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    slots as never,
  );

const buildCommunitiesController = (
  communitiesService: object,
  slots: object,
) =>
  new CommunitiesController(
    communitiesService as never,
    {} as never,
    slots as never,
  );

describe('creator draft publish paths', () => {
  it('deletes the caller event draft after POST /events succeeds and returns the created event', async () => {
    const created = { slug: 'swap-1', occurrenceSlugs: ['swap-1'] };
    const eventsService = { create: jest.fn().mockResolvedValue(created) };
    const slots = {
      discardAfterPublish: jest.fn().mockResolvedValue(undefined),
    };
    const controller = buildEventsController(eventsService, slots);
    await expect(controller.create(MEMBER, DTO)).resolves.toBe(created);
    expect(slots.discardAfterPublish).toHaveBeenCalledWith('member-1', 'event');
  });

  it('keeps the event draft when the create fails', async () => {
    const eventsService = {
      create: jest
        .fn()
        .mockRejectedValue(new BadRequestException('past start')),
    };
    const slots = { discardAfterPublish: jest.fn() };
    const controller = buildEventsController(eventsService, slots);
    await expect(controller.create(MEMBER, DTO)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(slots.discardAfterPublish).not.toHaveBeenCalled();
  });

  it('deletes the caller community draft after POST /communities succeeds', async () => {
    const created = { slug: 'book-club' };
    const communitiesService = {
      create: jest.fn().mockResolvedValue(created),
    };
    const slots = {
      discardAfterPublish: jest.fn().mockResolvedValue(undefined),
    };
    const controller = buildCommunitiesController(communitiesService, slots);
    await expect(controller.create(MEMBER, DTO)).resolves.toBe(created);
    expect(slots.discardAfterPublish).toHaveBeenCalledWith(
      'member-1',
      'community',
    );
  });

  it('keeps the community draft when the create fails', async () => {
    const communitiesService = {
      create: jest.fn().mockRejectedValue(new BadRequestException('invalid')),
    };
    const slots = { discardAfterPublish: jest.fn() };
    const controller = buildCommunitiesController(communitiesService, slots);
    await expect(controller.create(MEMBER, DTO)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(slots.discardAfterPublish).not.toHaveBeenCalled();
  });
});
