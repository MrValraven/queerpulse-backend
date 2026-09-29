import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { Connection } from '../connections/entities/connection.entity';
import { ModAuditService } from '../moderation/mod-audit.service';
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
  let modAudit: { writeAuditLog: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue(undefined) };

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
        // `createListing` announces to the housing-group-listing queue; the
        // review paths under test never reach it, so a bare stub is enough.
        {
          provide: AdminQueueNotificationsService,
          useValue: { announce: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: ModAuditService, useValue: modAudit },
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

  describe('setListingHidden (PRD-463, ENG-490)', () => {
    const REASON = 'The listing asks for a broker fee.';

    it('hides a listing, stores the reason, and tells the poster why', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: GroupListingStatus.Live }),
      );

      await service.setListingHidden(
        'listing-1',
        { hidden: true, reason: `  ${REASON}  ` },
        'moderator-1',
      );

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: true, hiddenReason: REASON }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'member-9',
        NotificationType.GroupListingDecided,
        {
          source: 'housing_group',
          decision: 'hidden',
          groupSlug: 'sao-bento-flatshares',
          groupName: 'Sao Bento flatshares',
          listingTitle: 'Sunny room off Rua da Bica',
          reason: REASON,
        },
      );
    });

    it('records the hide in the audit trail with the acting staff member and the reason', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: GroupListingStatus.Live }),
      );

      await service.setListingHidden(
        'listing-1',
        { hidden: true, reason: REASON },
        'moderator-1',
      );

      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'moderator-1',
        'housing_group_listing_hide',
        undefined,
        expect.stringMatching(/listing-1.*broker fee/),
      );
    });

    it('refuses a hide with no reason, and writes nothing', async () => {
      listings.findOne.mockResolvedValue(makeListing());

      await expect(
        service.setListingHidden(
          'listing-1',
          { hidden: true, reason: '   ' },
          'moderator-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(listings.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('un-hides a live listing, tells the poster it is live, and audits the unhide', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({
          status: GroupListingStatus.Live,
          hidden: true,
          hiddenReason: REASON,
        }),
      );

      await service.setListingHidden(
        'listing-1',
        { hidden: false, reason: 'ignored on unhide' },
        'moderator-2',
      );

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: false, hiddenReason: null }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'member-9',
        NotificationType.GroupListingDecided,
        {
          source: 'housing_group',
          decision: GroupListingStatus.Live,
          groupSlug: 'sao-bento-flatshares',
          groupName: 'Sao Bento flatshares',
          listingTitle: 'Sunny room off Rua da Bica',
        },
      );
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'moderator-2',
        'housing_group_listing_unhide',
        undefined,
        expect.stringContaining('listing-1'),
      );
    });

    // Un-hiding a listing that never passed review leaves it invisible, so
    // telling the poster it is live would be false.
    it('does not tell the poster "live" when the un-hidden listing is still in review', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ hidden: true, hiddenReason: REASON }),
      );

      await service.setListingHidden(
        'listing-1',
        { hidden: false },
        'moderator-1',
      );

      expect(listings.save).toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    // A listing still in review was never on the board, so hiding it changes
    // nothing its poster can see. The takedown and its audit row still land.
    it('does not send the hidden notice when the listing was never live', async () => {
      listings.findOne.mockResolvedValue(makeListing());

      await service.setListingHidden(
        'listing-1',
        { hidden: true, reason: REASON },
        'moderator-1',
      );

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: true, hiddenReason: REASON }),
      );
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'moderator-1',
        'housing_group_listing_hide',
        undefined,
        expect.stringContaining('listing-1'),
      );
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('does not repeat the notice for a second identical hide', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({
          status: GroupListingStatus.Live,
          hidden: true,
          hiddenReason: REASON,
        }),
      );

      await service.setListingHidden(
        'listing-1',
        { hidden: true, reason: REASON },
        'moderator-1',
      );

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('skips the notice silently when the listing has no poster', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: GroupListingStatus.Live, postedByUserId: null }),
      );

      await expect(
        service.setListingHidden(
          'listing-1',
          { hidden: true, reason: REASON },
          'moderator-1',
        ),
      ).resolves.toMatchObject({ hidden: true });
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});
