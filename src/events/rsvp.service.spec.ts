import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { EventStatus } from './entities/event.entity';
import { RsvpService } from './rsvp.service';

describe('RsvpService', () => {
  let service: RsvpService;
  let managerFindOne: jest.Mock;
  let rsvpRepo: {
    count: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    managerFindOne = jest.fn();
    rsvpRepo = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (r) => r),
      create: jest.fn((r) => r),
      createQueryBuilder: jest.fn(() => ({
        select: () => ({
          where: () => ({ getRawOne: async () => ({ max: 0 }) }),
        }),
      })),
    };
    emitter = { emit: jest.fn() };
    const manager = { getRepository: () => rsvpRepo, findOne: managerFindOne };
    const dataSource = {
      transaction: jest.fn(async (cb) => cb(manager)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RsvpService,
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(RsvpService);
  });

  it('rejects RSVP on a non-published event', async () => {
    managerFindOne.mockResolvedValue({ id: 'e1', status: EventStatus.Draft });
    await expect(service.rsvp('e', 'u1', 'going')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('waitlists a going RSVP when capacity is full', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 2,
    });
    rsvpRepo.count.mockResolvedValue(2); // full
    const result = await service.rsvp('e', 'u1', 'going');
    expect(result.status).toBe(RsvpStatus.Waitlisted);
    expect(result.waitlistPosition).toBe(1);
  });

  it('admits a going RSVP under capacity', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 5,
    });
    rsvpRepo.count.mockResolvedValue(1);
    const result = await service.rsvp('e', 'u1', 'going');
    expect(result.status).toBe(RsvpStatus.Going);
  });

  it('promotes the waitlist head and emits when a going RSVP cancels', async () => {
    managerFindOne.mockResolvedValue({ id: 'e1', capacity: 1 });
    rsvpRepo.findOne
      .mockResolvedValueOnce({
        eventId: 'e1',
        userId: 'u1',
        status: RsvpStatus.Going,
      }) // mine
      .mockResolvedValueOnce({
        eventId: 'e1',
        userId: 'u2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
      }); // head
    await service.cancelRsvp('e', 'u1');
    expect(emitter.emit).toHaveBeenCalledWith(
      'event.waitlist_promoted',
      expect.objectContaining({ eventId: 'e1', userId: 'u2' }),
    );
  });
});
