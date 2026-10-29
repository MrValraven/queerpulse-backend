import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Event } from '../events/entities/event.entity';
import { GatheringFamily } from '../events/gathering-family';
import { GoTogetherHouseService } from '../go-together/go-together-house.service';
import {
  HouseMusicEventScopeService,
  isHouseMusicEvent,
} from './house-music-event-scope.service';

const HOUSE_USER_ID = 'house-user-1';
const MEMBER_USER_ID = 'member-user-1';

function eventFixture(overrides: Partial<Event>): Event {
  const fixture: Partial<Event> = {
    id: 'event-1',
    slug: 'friday-set',
    hostId: HOUSE_USER_ID,
    gatheringFamily: GatheringFamily.Music,
    ...overrides,
  };
  return fixture as Event;
}

async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(404);
  expect(exception.getResponse()).toMatchObject({
    code: 'music_event_not_found',
  });
}

describe('HouseMusicEventScopeService', () => {
  let service: HouseMusicEventScopeService;
  const findOne = jest.fn();
  const houseUserId = jest.fn();

  beforeEach(async () => {
    findOne.mockReset();
    houseUserId.mockReset().mockResolvedValue(HOUSE_USER_ID);
    const moduleRef = await Test.createTestingModule({
      providers: [
        HouseMusicEventScopeService,
        { provide: getRepositoryToken(Event), useValue: { findOne } },
        { provide: GoTogetherHouseService, useValue: { houseUserId } },
      ],
    }).compile();
    service = moduleRef.get(HouseMusicEventScopeService);
  });

  it('returns the event and the house id for a house-hosted Music event', async () => {
    const event = eventFixture({});
    findOne.mockResolvedValue(event);
    await expect(service.loadOrNotFound('friday-set')).resolves.toEqual({
      event,
      houseUserId: HOUSE_USER_ID,
    });
    expect(findOne).toHaveBeenCalledWith({ where: { slug: 'friday-set' } });
  });

  it('answers music_event_not_found for a member-hosted Music event', async () => {
    findOne.mockResolvedValue(eventFixture({ hostId: MEMBER_USER_ID }));
    await expectNotFound(service.loadOrNotFound('friday-set'));
  });

  it('answers music_event_not_found for a house-hosted Party event', async () => {
    findOne.mockResolvedValue(
      eventFixture({ gatheringFamily: GatheringFamily.Party }),
    );
    await expectNotFound(service.loadOrNotFound('friday-set'));
  });

  it('answers music_event_not_found for a house event with no family', async () => {
    findOne.mockResolvedValue(eventFixture({ gatheringFamily: null }));
    await expectNotFound(service.loadOrNotFound('friday-set'));
  });

  it('answers music_event_not_found for an unknown slug', async () => {
    findOne.mockResolvedValue(null);
    await expectNotFound(service.loadOrNotFound('no-such-event'));
  });

  it('exposes the house account id', async () => {
    await expect(service.houseUserId()).resolves.toBe(HOUSE_USER_ID);
  });
});

describe('isHouseMusicEvent', () => {
  it('is true only for a house-hosted Music event', () => {
    expect(
      isHouseMusicEvent(
        { hostId: HOUSE_USER_ID, gatheringFamily: GatheringFamily.Music },
        HOUSE_USER_ID,
      ),
    ).toBe(true);
    expect(
      isHouseMusicEvent(
        { hostId: null, gatheringFamily: GatheringFamily.Music },
        HOUSE_USER_ID,
      ),
    ).toBe(false);
  });
});
