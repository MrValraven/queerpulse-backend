import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { Connection } from '../connections/entities/connection.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationService } from '../verification/verification.service';
import { GroupJoinRequest } from './entities/group-join-request.entity';
import {
  GroupListing,
  GroupListingStatus,
} from './entities/group-listing.entity';
import { HousingGroup } from './entities/housing-group.entity';
import { HousingGroupsService } from './housing-groups.service';

/**
 * The LOC-19 decision paths on a group listing: a review that reaches the
 * person who posted the room, with an audit trail and a required reason where
 * a refusal is being made. The surrounding create/edit/withdraw behaviour is
 * covered by the module's existing e2e coverage and is not re-tested here.
 */

// Only the three fields the review path reads. The listing factory casts the
// whole row, so the group does not have to be a complete entity here.
const GROUP: Pick<HousingGroup, 'id' | 'slug' | 'name'> = {
  id: 'group-1',
  slug: 'sao-bento-flatshares',
  name: 'Sao Bento flatshares',
};

function makeListing(overrides: Partial<GroupListing> = {}): GroupListing {
  return {
    id: 'listing-1',
    groupId: 'group-1',
    group: GROUP as HousingGroup,
    title: 'Sunny room off Rua da Bica',
    description: 'A room in a four-person house.',
    neighbourhood: 'Bica',
    priceEuros: 480,
    accessibilityInfo: 'Two flights of stairs, no lift.',
    status: GroupListingStatus.Review,
    riskScore: 10,
    riskReasons: ['no_photos'],
    hidden: false,
    hiddenReason: null,
    postedByUserId: 'member-9',
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('HousingGroupsService — group-listing review (LOC-19)', () => {
  let service: HousingGroupsService;
  let listings: { findOne: jest.Mock; save: jest.Mock };
  let notifications: { create: jest.Mock };
  let profiles: { find: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    profiles = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HousingGroupsService,
        { provide: getRepositoryToken(HousingGroup), useValue: {} },
        { provide: getRepositoryToken(GroupJoinRequest), useValue: {} },
        { provide: getRepositoryToken(GroupListing), useValue: listings },
        { provide: getRepositoryToken(Connection), useValue: {} },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: AffirmingPledgeService, useValue: {} },
        { provide: VerificationService, useValue: {} },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(HousingGroupsService);
  });

  it('404s a listing that is not there', async () => {
    await expect(
      service.setListingStatus(
        'missing',
        { status: GroupListingStatus.Live },
        'moderator-1',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('publishes a listing, stamps the decision, and tells the poster where it is', async () => {
    listings.findOne.mockResolvedValue(makeListing());

    const result = await service.setListingStatus(
      'listing-1',
      { status: GroupListingStatus.Live },
      'moderator-1',
    );

    expect(listings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: GroupListingStatus.Live,
        decidedBy: 'moderator-1',
        decidedAt: expect.any(Date) as unknown,
      }),
    );
    expect(notifications.create).toHaveBeenCalledWith(
      'member-9',
      NotificationType.GroupListingDecided,
      expect.objectContaining({
        decision: GroupListingStatus.Live,
        groupSlug: 'sao-bento-flatshares',
        groupName: 'Sao Bento flatshares',
        listingTitle: 'Sunny room off Rua da Bica',
      }),
    );
    expect(result.status).toBe(GroupListingStatus.Live);
    expect(result.decidedBy).toBe('moderator-1');
  });

  it('refuses a decline with no reason, and writes nothing', async () => {
    listings.findOne.mockResolvedValue(makeListing());

    await expect(
      service.setListingStatus(
        'listing-1',
        { status: GroupListingStatus.Declined },
        'moderator-1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(listings.save).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only question as no question at all', async () => {
    listings.findOne.mockResolvedValue(makeListing());

    await expect(
      service.setListingStatus(
        'listing-1',
        { status: GroupListingStatus.Question, reason: '   ' },
        'moderator-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('sends the decline reason to the poster', async () => {
    listings.findOne.mockResolvedValue(makeListing());

    await service.setListingStatus(
      'listing-1',
      {
        status: GroupListingStatus.Declined,
        reason: 'The price does not include the deposit terms.',
      },
      'moderator-1',
    );

    expect(notifications.create).toHaveBeenCalledWith(
      'member-9',
      NotificationType.GroupListingDecided,
      expect.objectContaining({
        decision: GroupListingStatus.Declined,
        reason: 'The price does not include the deposit terms.',
      }),
    );
  });

  // Sending a listing back to `review` is the queue's own bookkeeping: nobody
  // has decided anything, so there is no verdict to report.
  it('stays silent when a listing goes back to review', async () => {
    listings.findOne.mockResolvedValue(
      makeListing({ status: GroupListingStatus.Live }),
    );

    await service.setListingStatus(
      'listing-1',
      { status: GroupListingStatus.Review },
      'moderator-1',
    );

    expect(listings.save).toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('is idempotent: a repeat of a recorded decision writes and notifies nothing', async () => {
    listings.findOne.mockResolvedValue(
      makeListing({
        status: GroupListingStatus.Live,
        decidedAt: new Date('2026-08-02T00:00:00.000Z'),
        decidedBy: 'moderator-1',
      }),
    );

    await service.setListingStatus(
      'listing-1',
      { status: GroupListingStatus.Live },
      'moderator-2',
    );

    expect(listings.save).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  // A listing posted before the poster column existed has nobody to tell. The
  // decision still commits.
  it('decides an unattributed listing without notifying anybody', async () => {
    listings.findOne.mockResolvedValue(makeListing({ postedByUserId: null }));

    const result = await service.setListingStatus(
      'listing-1',
      { status: GroupListingStatus.Live },
      'moderator-1',
    );

    expect(listings.save).toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
    expect(result.postedBy).toBeNull();
  });

  // The decision has already committed when the notification is attempted, so
  // a delivery failure must never surface as a 500 the moderator retries.
  it('survives a notification failure', async () => {
    listings.findOne.mockResolvedValue(makeListing());
    notifications.create.mockRejectedValue(new Error('bell is down'));

    await expect(
      service.setListingStatus(
        'listing-1',
        { status: GroupListingStatus.Live },
        'moderator-1',
      ),
    ).resolves.toMatchObject({ status: GroupListingStatus.Live });
  });
});
