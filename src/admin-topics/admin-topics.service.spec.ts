import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Topic } from '../content/entities/topic.entity';
import { ModAuditService } from '../moderation/mod-audit.service';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { AdminTopicsService } from './admin-topics.service';

const TOPIC_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = '22222222-2222-2222-2222-222222222222';

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: TOPIC_ID,
    tag: 'community-care',
    label: 'Community care',
    description: 'Mutual aid and support.',
    crisisCard: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    archivedAt: null,
    ...overrides,
  } as Topic;
}

describe('AdminTopicsService', () => {
  let service: AdminTopicsService;
  let topics: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock };
  let topicFollows: { delete: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let manager: { delete: jest.Mock };

  beforeEach(async () => {
    topics = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
    };
    topicFollows = { delete: jest.fn().mockResolvedValue(undefined) };
    manager = { delete: jest.fn().mockResolvedValue(undefined) };
    dataSource = {
      transaction: jest.fn((work: (manager: unknown) => Promise<unknown>) =>
        work(manager),
      ),
    };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTopicsService,
        { provide: getRepositoryToken(Topic), useValue: topics },
        { provide: getRepositoryToken(TopicFollow), useValue: topicFollows },
        { provide: DataSource, useValue: dataSource },
        { provide: ModAuditService, useValue: modAudit },
      ],
    }).compile();

    service = module.get(AdminTopicsService);
  });

  describe('remove', () => {
    it('404s when no topic carries that id', async () => {
      topics.findOne.mockResolvedValue(null);

      await expect(service.remove(TOPIC_ID, ACTOR_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('deletes the topic and its follows and writes the audit row in one transaction', async () => {
      const topic = makeTopic();
      topics.findOne.mockResolvedValue(topic);

      await service.remove(TOPIC_ID, ACTOR_ID);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.delete).toHaveBeenNthCalledWith(1, Topic, TOPIC_ID);
      expect(manager.delete).toHaveBeenNthCalledWith(2, TopicFollow, {
        topicSlug: topic.tag,
      });
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        ACTOR_ID,
        'topic_hard_delete',
        undefined,
        expect.stringContaining(topic.tag),
        undefined,
        manager,
      );
    });

    it('names the acting staff member as the audit row actor', async () => {
      topics.findOne.mockResolvedValue(makeTopic());

      await service.remove(TOPIC_ID, ACTOR_ID);

      const actorId = modAudit.writeAuditLog.mock.calls[0][1] as string;
      expect(actorId).toBe(ACTOR_ID);
    });

    it('propagates a failed delete so the caller transaction rolls back and no audit row is written', async () => {
      topics.findOne.mockResolvedValue(makeTopic());
      manager.delete.mockRejectedValueOnce(new ConflictException('locked'));

      await expect(service.remove(TOPIC_ID, ACTOR_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });
  });
});
