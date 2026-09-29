import { DataSource, Repository } from 'typeorm';
import { CommunitiesService } from '../communities/communities.service';
import { Community } from '../communities/entities/community.entity';
import { CardProgramsService } from '../membership-cards/card-programs.service';
import { OfficialConversationsService } from '../official-messages/official-conversations.service';
import {
  CIRCLE_CARD_PROGRAM,
  CIRCLE_COMMUNITY_INPUT,
} from './ambassador-circle.data';
import { AmbassadorCircleService } from './ambassador-circle.service';
import { AmbassadorCircle } from './entities/ambassador-circle.entity';

/**
 * The circle is founded lazily, so the dangerous moment is the very first
 * grant. These pin the lock around creation, the re-read inside it (two first
 * grants racing must found one circle, Review Focus 4), and the unlock on
 * every exit.
 */

const circleCommunity = {
  id: 'circle-1',
  slug: 'queerpulse-ambassadors',
  name: 'QueerPulse Ambassadors',
} as Community;

describe('AmbassadorCircleService', () => {
  function buildService(options: {
    pinResults: (AmbassadorCircle | null)[];
    createError?: Error;
  }) {
    const lockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = { createQueryRunner: jest.fn(() => lockRunner) };
    const circlePinRepository = {
      findOne: jest.fn(),
      insert: jest.fn().mockResolvedValue({ identifiers: [], raw: [] }),
    };
    for (const pinResult of options.pinResults) {
      circlePinRepository.findOne.mockResolvedValueOnce(pinResult);
    }
    circlePinRepository.findOne.mockResolvedValue(null);
    const communitiesRepository = {
      findOne: jest.fn().mockResolvedValue(circleCommunity),
      findOneOrFail: jest.fn().mockResolvedValue(circleCommunity),
    };
    const communitiesService = {
      create: options.createError
        ? jest.fn().mockRejectedValue(options.createError)
        : jest.fn().mockResolvedValue({ slug: circleCommunity.slug }),
    };
    const cardPrograms = { upsert: jest.fn().mockResolvedValue({}) };
    const officialConversations = {
      resolveOfficialSenderId: jest.fn().mockResolvedValue('house-account'),
    };
    const service = new AmbassadorCircleService(
      dataSource as unknown as DataSource,
      circlePinRepository as unknown as Repository<AmbassadorCircle>,
      communitiesRepository as unknown as Repository<Community>,
      communitiesService as unknown as CommunitiesService,
      cardPrograms as unknown as CardProgramsService,
      officialConversations as unknown as OfficialConversationsService,
    );
    return {
      service,
      lockRunner,
      dataSource,
      circlePinRepository,
      communitiesRepository,
      communitiesService,
      cardPrograms,
    };
  }

  const pinRow = { id: 1, communityId: 'circle-1' } as AmbassadorCircle;

  it('returns the pinned community without taking the lock or creating one', async () => {
    const { service, dataSource, communitiesService, communitiesRepository } =
      buildService({ pinResults: [pinRow] });

    await expect(service.resolveCircle()).resolves.toBe(circleCommunity);

    expect(communitiesRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
    });
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(communitiesService.create).not.toHaveBeenCalled();
  });

  it('founds the circle under the advisory lock with the house account, pins it, switches the card on and unlocks', async () => {
    const {
      service,
      lockRunner,
      circlePinRepository,
      communitiesService,
      cardPrograms,
    } = buildService({ pinResults: [null, null] });

    await expect(service.resolveCircle()).resolves.toBe(circleCommunity);

    expect(lockRunner.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('pg_advisory_lock'),
    );
    expect(communitiesService.create).toHaveBeenCalledWith(
      'house-account',
      CIRCLE_COMMUNITY_INPUT,
    );
    expect(circlePinRepository.insert).toHaveBeenCalledWith({
      id: 1,
      communityId: 'circle-1',
    });
    expect(cardPrograms.upsert).toHaveBeenCalledWith(
      'queerpulse-ambassadors',
      'house-account',
      CIRCLE_CARD_PROGRAM,
    );
    expect(lockRunner.query).toHaveBeenLastCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('creates the circle with the agreed identity: private, with a coral card', () => {
    expect(CIRCLE_COMMUNITY_INPUT.name).toBe('QueerPulse Ambassadors');
    expect(CIRCLE_COMMUNITY_INPUT.handle).toBe('queerpulse-ambassadors');
    expect(CIRCLE_COMMUNITY_INPUT.accessTier).toBe('private');
    expect(CIRCLE_CARD_PROGRAM.cardName).toBe('QueerPulse Ambassador');
    expect(CIRCLE_CARD_PROGRAM.skin).toBe('coral');
    expect(CIRCLE_CARD_PROGRAM.isEnabled).toBe(true);
  });

  it('releases the lock when the create throws, and pins nothing', async () => {
    const { service, lockRunner, circlePinRepository, cardPrograms } =
      buildService({
        pinResults: [null, null],
        createError: new Error('create failed'),
      });

    await expect(service.resolveCircle()).rejects.toThrow('create failed');

    expect(circlePinRepository.insert).not.toHaveBeenCalled();
    expect(cardPrograms.upsert).not.toHaveBeenCalled();
    expect(lockRunner.query).toHaveBeenLastCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('re-reads the pin inside the lock, so the loser of a first-grant race creates nothing (Review Focus 4)', async () => {
    // First read: no pin yet. The read inside the lock sees the pin the
    // winner wrote while this call waited on `pg_advisory_lock`.
    const { service, lockRunner, communitiesService, circlePinRepository } =
      buildService({ pinResults: [null, pinRow] });

    await expect(service.resolveCircle()).resolves.toBe(circleCommunity);

    expect(lockRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_lock'),
    );
    expect(circlePinRepository.findOne).toHaveBeenCalledTimes(2);
    expect(communitiesService.create).not.toHaveBeenCalled();
    expect(circlePinRepository.insert).not.toHaveBeenCalled();
    expect(lockRunner.query).toHaveBeenLastCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });
});
