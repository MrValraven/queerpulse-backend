import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { Listing } from '../listings/entities/listing.entity';
import { Profile } from '../users/entities/profile.entity';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { Inquiry } from './entities/inquiry.entity';
import { InquiriesService } from './inquiries.service';

describe('InquiriesService', () => {
  let service: InquiriesService;
  let inquiries: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    count: jest.Mock;
  };
  let listings: { find: jest.Mock };
  let queryBuilder: {
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    andWhere: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let adminQueueNotifications: { announce: jest.Mock };

  const contactMessage = (
    overrides: Partial<CreateInquiryDto> = {},
  ): CreateInquiryDto => ({
    kind: 'contact',
    name: 'Sam',
    email: 'sam@example.com',
    subject: 'Safety concern',
    body: 'Someone at a gathering made me feel unsafe.',
    ...overrides,
  });

  beforeEach(async () => {
    inquiries = {
      save: jest
        .fn()
        .mockImplementation((row: Partial<Inquiry>) =>
          Promise.resolve({ id: 'inquiry-1', ...row }),
        ),
      create: jest.fn((value: object) => value),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => queryBuilder),
      count: jest.fn().mockResolvedValue(0),
    };
    queryBuilder = {
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    listings = { find: jest.fn().mockResolvedValue([]) };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: getRepositoryToken(Inquiry), useValue: inquiries },
        { provide: getRepositoryToken(Profile), useValue: {} },
        { provide: getRepositoryToken(Listing), useValue: listings },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();

    service = module.get(InquiriesService);
  });

  describe('create', () => {
    it('stores a safety concern as priority and announces it to staff', async () => {
      await service.create(contactMessage({ topic: 'safety' }));

      expect(inquiries.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPriority: true, status: 'new' }),
      );
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.SafetyInquiries,
        'inquiry-1',
      );
      expect(adminQueueNotifications.announce).not.toHaveBeenCalledWith(
        AdminQueueKey.Intakes,
        expect.anything(),
      );
    });

    it('reads the topic id, so a translated subject label still counts', async () => {
      await service.create(
        contactMessage({
          topic: 'safety',
          subject: 'Preocupação de segurança',
        }),
      );

      expect(adminQueueNotifications.announce).toHaveBeenCalledTimes(1);
    });

    it('keeps any other topic in date order and quiet', async () => {
      await service.create(
        contactMessage({
          topic: 'press',
          subject: 'Press or research inquiry',
        }),
      );

      expect(inquiries.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPriority: false }),
      );
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('leaves a message sent with no topic quiet', async () => {
      await service.create(contactMessage());

      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('ignores a topic on a partnership inquiry', async () => {
      await service.create(
        contactMessage({ kind: 'partner', topic: 'safety', orgName: 'Casa' }),
      );

      expect(inquiries.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPriority: false }),
      );
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('acknowledges with the id and status only', async () => {
      await expect(
        service.create(contactMessage({ topic: 'safety' })),
      ).resolves.toEqual({ id: 'inquiry-1', status: 'new' });
    });

    it('stores a listing correction under its own kind with the listing ref', async () => {
      await service.create(
        contactMessage({
          kind: 'listing_correction',
          topic: 'listing_correction',
          subject: 'Correction to a directory listing',
          body: 'The opening hours on Sundays are wrong.',
          listingRef: 'QPL-2026-0007',
        }),
      );

      expect(inquiries.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'listing_correction',
          listingRef: 'QPL-2026-0007',
          isPriority: false,
        }),
      );
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('drops a listing ref sent on any other kind', async () => {
      await service.create(
        contactMessage({ topic: 'press', listingRef: 'QPL-2026-0007' }),
      );

      expect(inquiries.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'contact', listingRef: null }),
      );
    });
  });

  describe('list', () => {
    const storedInquiry = (overrides: Partial<Inquiry> = {}): Inquiry => ({
      id: 'inquiry-1',
      kind: 'listing_correction',
      senderName: 'Sam',
      email: 'sam@example.com',
      subject: 'Correction to a directory listing',
      body: 'The opening hours on Sundays are wrong.',
      orgName: null,
      status: 'new',
      handledById: null,
      handledAt: null,
      isPriority: false,
      listingRef: 'QPL-2026-0007',
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      ...overrides,
    });

    it('resolves a correction to its listing in one batched read', async () => {
      queryBuilder.getManyAndCount.mockResolvedValue([
        [
          storedInquiry(),
          storedInquiry({ id: 'inquiry-2' }),
          storedInquiry({ id: 'inquiry-3', kind: 'contact', listingRef: null }),
        ],
        3,
      ]);
      listings.find.mockResolvedValue([
        {
          ref: 'QPL-2026-0007',
          name: 'Café Arco',
          slug: 'cafe-arco',
          status: 'live',
          isHiddenByOwner: false,
        },
      ]);

      const result = await service.list({});

      expect(listings.find).toHaveBeenCalledTimes(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          kind: 'listing_correction',
          listingRef: 'QPL-2026-0007',
          listing: {
            ref: 'QPL-2026-0007',
            name: 'Café Arco',
            slug: 'cafe-arco',
            isPublic: true,
          },
        }),
      );
      expect(result.items[2]).toEqual(
        expect.objectContaining({ listingRef: null, listing: null }),
      );
    });

    it('keeps the ref but no listing when the listing is gone', async () => {
      queryBuilder.getManyAndCount.mockResolvedValue([[storedInquiry()], 1]);
      listings.find.mockResolvedValue([]);

      const result = await service.list({});

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          listingRef: 'QPL-2026-0007',
          listing: null,
        }),
      );
    });

    it('marks a listing that is not publicly visible', async () => {
      queryBuilder.getManyAndCount.mockResolvedValue([[storedInquiry()], 1]);
      listings.find.mockResolvedValue([
        {
          ref: 'QPL-2026-0007',
          name: 'Café Arco',
          slug: 'cafe-arco',
          status: 'review',
          isHiddenByOwner: false,
        },
      ]);

      const result = await service.list({});

      expect(result.items[0]?.listing?.isPublic).toBe(false);
    });

    it('skips the listing read when no row carries a ref', async () => {
      queryBuilder.getManyAndCount.mockResolvedValue([
        [storedInquiry({ kind: 'contact', listingRef: null })],
        1,
      ]);

      await service.list({});

      expect(listings.find).not.toHaveBeenCalled();
    });
  });
});
