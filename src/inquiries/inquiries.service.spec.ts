import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { Profile } from '../users/entities/profile.entity';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { Inquiry } from './entities/inquiry.entity';
import { InquiriesService } from './inquiries.service';

describe('InquiriesService', () => {
  let service: InquiriesService;
  let inquiries: { save: jest.Mock; create: jest.Mock };
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
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: getRepositoryToken(Inquiry), useValue: inquiries },
        { provide: getRepositoryToken(Profile), useValue: {} },
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
        AdminQueueKey.Intakes,
        'inquiry-1',
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
  });
});
