import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MessagingService } from '../messaging/messaging.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { ListingEnquiry } from './entities/listing-enquiry.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import { ListingEnquiriesService } from './listing-enquiries.service';

const baseListing = (overrides: Partial<Listing> = {}): Listing =>
  ({
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'drama-bar',
    name: 'Drama Bar',
    ownerId: 'owner-1',
    status: ListingStatus.Live,
    path: 'own',
    badge: 'owned',
    isHiddenByOwner: false,
    ...overrides,
  }) as Listing;

const activeOwner = {
  id: 'owner-1',
  isSystem: false,
  status: UserStatus.Active,
};

const HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * HOUR_MS;

/** The caps and their sentences, restated here rather than imported: they are
 *  private to the service on purpose, and a test that reads them from the
 *  implementation would agree with a typo. */
const MAX_PER_LISTING = 3;
const MAX_PER_DAY = 20;
const LISTING_CAP_SENTENCE =
  'You have already written to this business today. Give them a chance to reply first.';
const DIRECTORY_CAP_SENTENCE =
  'You have sent a lot of enquiries today. Try again tomorrow.';

/** Rows as the quota read gets them: NEWEST FIRST, inside the rolling day.
 *  Fewest hours ago sorts first, so index 0 is the most recent enquiry and the
 *  last element is the oldest one still inside the window. */
const enquiryRows = (listingId: string, hoursAgo: number[]) =>
  [...hoursAgo]
    .sort((left, right) => left - right)
    .map((hours, index) => ({
      id: `enquiry-${index}`,
      listingId,
      createdAt: new Date(Date.now() - hours * HOUR_MS),
    }));

/** The service reads the caller's rows newest-first straight out of the index,
 *  so a fixture built from more than one listing has to be merged the same way
 *  or the release times come out of the wrong row. */
const newestFirst = <Row extends { createdAt: Date }>(...rowSets: Row[][]) =>
  rowSets
    .flat()
    .sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );

/**
 * Both caps biting at once, and the directory one lifting LATER than the
 * per-listing one. Three enquiries to this listing are the OLDEST rows in the
 * window, so the per-listing cap lifts first; the window is full, so the
 * directory cap lifts only when the 20th-newest row ages out, which is newer.
 */
const bothCapsBiting = () => {
  const listingRows = enquiryRows('listing-1', [23, 22.5, 22]);
  const elsewhereRows = enquiryRows(
    'listing-elsewhere',
    Array.from({ length: 18 }, (unused, index) => index + 1),
  );
  return {
    listingRows,
    elsewhereRows,
    rows: newestFirst(listingRows, elsewhereRows),
  };
};

/** Every field of the contact DTO that is not about the caps, so a test about
 *  the caps can assert the whole object without restating the rest. */
const REACHABLE = {
  canMessageOwner: true,
  unavailableReason: null,
  replyRequiresConnection: true,
  existingConversationId: null,
};
const UNCAPPED = {
  hasReachedEnquiryLimit: false,
  enquiryLimitReason: null,
  enquiryLimitClearsAt: null,
};

describe('ListingEnquiriesService', () => {
  let service: ListingEnquiriesService;
  let listings: { findOne: jest.Mock };
  let enquiries: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock<
      Promise<Partial<ListingEnquiry>>,
      [Partial<ListingEnquiry>]
    >;
  };
  let users: { findOne: jest.Mock };
  let messaging: {
    enquiryContactability: jest.Mock;
    deliverEnquiry: jest.Mock;
  };
  let contentModeration: { statesForAnyType: jest.Mock };

  beforeEach(async () => {
    listings = { findOne: jest.fn().mockResolvedValue(baseListing()) };
    enquiries = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value: Partial<ListingEnquiry>) => value),
      save: jest.fn((value: Partial<ListingEnquiry>) =>
        Promise.resolve({ id: 'enquiry-1', ...value }),
      ),
    };
    users = { findOne: jest.fn().mockResolvedValue(activeOwner) };
    messaging = {
      enquiryContactability: jest.fn().mockResolvedValue({
        canDeliver: true,
        blockedReason: null,
        replyRequiresConnection: true,
      }),
      deliverEnquiry: jest
        .fn()
        .mockResolvedValue({ conversationId: 'conversation-1' }),
    };
    contentModeration = { statesForAnyType: jest.fn(() => new Map()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingEnquiriesService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(ListingEnquiry), useValue: enquiries },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: MessagingService, useValue: messaging },
        {
          provide: ContentModerationService,
          useValue: contentModeration,
        },
      ],
    }).compile();

    service = module.get(ListingEnquiriesService);
  });

  describe('getContact', () => {
    it('offers the contact route on a claimed, live listing', async () => {
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact).toEqual({ ...REACHABLE, ...UNCAPPED });
    });

    it('deep-links a thread the member already started', async () => {
      enquiries.findOne.mockResolvedValue({
        id: 'enquiry-0',
        conversationId: 'conversation-9',
      });
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.existingConversationId).toBe('conversation-9');
    });

    // The `friendly`/`suggested` paths carry a non-null owner_id belonging to
    // whoever recommended the place, not to the business.
    it('refuses a suggested listing rather than messaging whoever suggested it', async () => {
      listings.findOne.mockResolvedValue(baseListing({ path: 'suggest' }));
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact).toMatchObject({
        canMessageOwner: false,
        unavailableReason: 'unclaimed',
      });
      expect(messaging.enquiryContactability).not.toHaveBeenCalled();
    });

    it('refuses a friendly recommendation for the same reason', async () => {
      listings.findOne.mockResolvedValue(baseListing({ badge: 'friendly' }));
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.unavailableReason).toBe('unclaimed');
    });

    it('refuses a listing parked on a platform account', async () => {
      users.findOne.mockResolvedValue({ ...activeOwner, isSystem: true });
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.unavailableReason).toBe('no_owner_account');
    });

    it('refuses a listing whose owner account was erased', async () => {
      users.findOne.mockResolvedValue(null);
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.unavailableReason).toBe('no_owner_account');
    });

    it('refuses a listing whose owner is suspended', async () => {
      users.findOne.mockResolvedValue({
        ...activeOwner,
        status: UserStatus.Suspended,
      });
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.unavailableReason).toBe('no_owner_account');
    });

    it('tells the owner it is their own listing', async () => {
      const contact = await service.getContact('drama-bar', 'owner-1');
      expect(contact.unavailableReason).toBe('own_listing');
    });

    // Reported without direction, so the endpoint cannot be used to test
    // whether a particular person has blocked you.
    it('reports a block without saying which way it runs', async () => {
      messaging.enquiryContactability.mockResolvedValue({
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
      });
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact).toMatchObject({
        canMessageOwner: false,
        unavailableReason: 'unavailable',
      });
    });

    it('404s a listing under a moderator takedown, like the public page does', async () => {
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([['drama-bar', { hidden: true, removed: false }]]),
      );
      await expect(service.getContact('drama-bar', 'member-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s a listing that is not live', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(service.getContact('drama-bar', 'member-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('send', () => {
    it('delivers through messaging and records the link to the listing', async () => {
      const result = await service.send('drama-bar', 'member-1', {
        body: 'Is the upstairs room step-free?',
      });

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'member-1',
        'owner-1',
        expect.stringContaining('Drama Bar'),
      );
      // The member's own words survive the context header untouched.
      const [, , deliveredBody] = messaging.deliverEnquiry.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(deliveredBody).toContain('Is the upstairs room step-free?');

      expect(enquiries.save).toHaveBeenCalledWith(
        expect.objectContaining({
          listingId: 'listing-1',
          senderId: 'member-1',
          ownerId: 'owner-1',
          conversationId: 'conversation-1',
        }),
      );
      expect(result).toEqual({
        conversationId: 'conversation-1',
        enquiryId: 'enquiry-1',
        replyRequiresConnection: true,
      });
    });

    // The enquiry row holds no message text; messaging still owns storage.
    it('never writes the member’s words into its own table', async () => {
      await service.send('drama-bar', 'member-1', {
        body: 'Something personal I would not post in public.',
      });
      const saved = JSON.stringify(enquiries.save.mock.calls[0]?.[0] ?? {});
      expect(saved).not.toContain('Something personal');
    });

    it('sends the DM before writing its own row, so a retry cannot duplicate it', async () => {
      const order: string[] = [];
      messaging.deliverEnquiry.mockImplementation(() => {
        order.push('deliver');
        return Promise.resolve({ conversationId: 'conversation-1' });
      });
      enquiries.save.mockImplementation((value: Partial<ListingEnquiry>) => {
        order.push('record');
        return Promise.resolve({ id: 'enquiry-1', ...value });
      });

      await service.send('drama-bar', 'member-1', { body: 'A question here.' });

      expect(order).toEqual(['deliver', 'record']);
    });

    it('refuses an unclaimed listing with a 400 rather than opening a dead thread', async () => {
      listings.findOne.mockResolvedValue(baseListing({ path: 'suggest' }));
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).rejects.toThrow(BadRequestException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('refuses when messaging says the two cannot be connected at all', async () => {
      messaging.enquiryContactability.mockResolvedValue({
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
      });
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).rejects.toThrow(ForbiddenException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('429s the fourth enquiry to one business in a day', async () => {
      enquiries.find.mockResolvedValue(enquiryRows('listing-1', [20, 10, 2]));
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).rejects.toThrow(
        new HttpException(LISTING_CAP_SENTENCE, HttpStatus.TOO_MANY_REQUESTS),
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('429s once the across-the-directory daily cap is hit', async () => {
      // Twenty enquiries today, none of them to THIS listing.
      enquiries.find.mockResolvedValue(
        enquiryRows(
          'listing-elsewhere',
          Array.from({ length: MAX_PER_DAY }, (unused, index) => index + 1),
        ),
      );
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).rejects.toThrow(
        new HttpException(DIRECTORY_CAP_SENTENCE, HttpStatus.TOO_MANY_REQUESTS),
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('lets a member who is under both caps through', async () => {
      enquiries.find.mockResolvedValue(
        newestFirst(
          enquiryRows('listing-1', [6, 2]),
          enquiryRows('listing-elsewhere', [9]),
        ),
      );
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).resolves.toMatchObject({ conversationId: 'conversation-1' });
    });

    // The caps are counted from ONE place. If the send path ever grew its own
    // count again, this is the test that would notice.
    it('counts the caps in a single bounded read rather than per-cap counts', async () => {
      await service.send('drama-bar', 'member-1', { body: 'A question here.' });
      expect(enquiries.find).toHaveBeenCalledTimes(1);
      expect(enquiries.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { createdAt: 'DESC' },
          take: MAX_PER_DAY + 1,
        }),
      );
    });
  });

  /**
   * The hint and the enforcement must never tell different stories. A composer
   * that opens on a send the backend will refuse wastes a member's message; one
   * that stays closed on a send that would have worked silently removes the only
   * contact route on the page that does not cost them their phone number.
   *
   * Every case here drives BOTH paths off the same rows and asserts they agree,
   * which is the property that matters. Asserting the read's shape alone would
   * pass against a hint computed from a second, drifting count.
   */
  describe('the contact read agrees with what the send path then does', () => {
    const sendBody = { body: 'A question here.' };

    it('reports nothing capped, and the send then goes through', async () => {
      enquiries.find.mockResolvedValue(enquiryRows('listing-1', [8, 3]));

      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact).toMatchObject(UNCAPPED);

      await expect(
        service.send('drama-bar', 'member-1', sendBody),
      ).resolves.toMatchObject({ conversationId: 'conversation-1' });
    });

    it('reports the per-listing cap, and the send then refuses with that same sentence', async () => {
      enquiries.find.mockResolvedValue(enquiryRows('listing-1', [23, 12, 1]));

      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.hasReachedEnquiryLimit).toBe(true);
      expect(contact.enquiryLimitReason).toBe('wrote_to_this_business_today');

      await expect(
        service.send('drama-bar', 'member-1', sendBody),
      ).rejects.toThrow(LISTING_CAP_SENTENCE);
    });

    it('reports the directory-wide cap, and the send then refuses with that same sentence', async () => {
      enquiries.find.mockResolvedValue(
        enquiryRows(
          'listing-elsewhere',
          Array.from({ length: MAX_PER_DAY }, (unused, index) => index + 1),
        ),
      );

      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.hasReachedEnquiryLimit).toBe(true);
      expect(contact.enquiryLimitReason).toBe('wrote_across_directory_today');

      await expect(
        service.send('drama-bar', 'member-1', sendBody),
      ).rejects.toThrow(DIRECTORY_CAP_SENTENCE);
    });

    // Both biting at once. The read names the per-listing cap because that is
    // the one the send path refuses with first.
    it('names the per-listing cap when both are biting, matching the refusal', async () => {
      enquiries.find.mockResolvedValue(bothCapsBiting().rows);

      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.enquiryLimitReason).toBe('wrote_to_this_business_today');

      await expect(
        service.send('drama-bar', 'member-1', sendBody),
      ).rejects.toThrow(LISTING_CAP_SENTENCE);
    });
  });

  describe('when the cap lifts', () => {
    it('is a rolling day from the oldest counted enquiry, never midnight', async () => {
      const rows = enquiryRows('listing-1', [23, 12, 1]);
      enquiries.find.mockResolvedValue(rows);

      const contact = await service.getContact('drama-bar', 'member-1');
      // Rows arrive newest first, so the 3rd is the oldest of the three: the
      // one whose ageing out drops the count below the cap.
      const oldest = rows[MAX_PER_LISTING - 1] as { createdAt: Date };
      expect(contact.enquiryLimitClearsAt).toBe(
        new Date(oldest.createdAt.getTime() + ONE_DAY_MS).toISOString(),
      );
    });

    // Promising the earlier of two biting caps would send a member back to a
    // button that refuses them again.
    it('is the later of the two caps when both are biting', async () => {
      const { listingRows, rows } = bothCapsBiting();
      enquiries.find.mockResolvedValue(rows);

      const contact = await service.getContact('drama-bar', 'member-1');

      const listingClearsAt =
        listingRows[MAX_PER_LISTING - 1]!.createdAt.getTime() + ONE_DAY_MS;
      const directoryClearsAt =
        rows[MAX_PER_DAY - 1]!.createdAt.getTime() + ONE_DAY_MS;
      expect(directoryClearsAt).toBeGreaterThan(listingClearsAt);
      expect(contact.enquiryLimitClearsAt).toBe(
        new Date(directoryClearsAt).toISOString(),
      );
    });
  });

  describe('the quota read is not run when there is nobody to write to', () => {
    it('skips it entirely on an unclaimed listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ path: 'suggest' }));
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact).toMatchObject(UNCAPPED);
      expect(enquiries.find).not.toHaveBeenCalled();
    });
  });
});
