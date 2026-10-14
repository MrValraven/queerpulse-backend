import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import { MetricsService } from '../metrics/metrics.service';
import { SubprofilePost } from '../subprofile-posts/entities/subprofile-post.entity';
import { Report, ReportSubjectType } from './entities/report.entity';
import { reasonsFor } from './reason-catalogue';
import { ReportsService } from './reports.service';

// Studio v3: a persona post report names a post by its uuid.
const POST_ID = '9d000000-0000-4000-8000-0000000000aa';

describe('ReportsService: the persona post subject', () => {
  let service: ReportsService;
  let reports: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    manager: { exists: jest.Mock };
  };

  beforeEach(async () => {
    reports = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: object) => value),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) =>
        Promise.resolve({
          id: 'report-1',
          createdAt: new Date('2026-10-13T00:00:00.000Z'),
          ...(row as object),
        }),
      ),
      // Only the post with `POST_ID` exists.
      manager: {
        exists: jest.fn((entity: unknown, options: { where: { id: string } }) =>
          Promise.resolve(
            entity === SubprofilePost && options.where.id === POST_ID,
          ),
        ),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getRepositoryToken(Report), useValue: reports },
        {
          provide: getRepositoryToken(Message),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(HousingListing),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(EventPhoto),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(ContentModeration),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: IdentitiesService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: MetricsService,
          useValue: { incrementReportFloodRefusal: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  const fileAgainst = (subjectId: string) =>
    service.create('reporter-1', {
      subjectType: ReportSubjectType.PersonaPost,
      subjectId,
      reasonCode: 'harassment',
    });

  it('files against a post by its lowercased uuid', async () => {
    await fileAgainst(POST_ID.toUpperCase());
    expect(reports.manager.exists).toHaveBeenCalledWith(SubprofilePost, {
      where: { id: POST_ID },
    });
    expect(reports.save).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: ReportSubjectType.PersonaPost,
        subjectId: POST_ID,
      }),
    );
  });

  it('answers 404 for a slug without querying, and for a post that is gone', async () => {
    await expect(fileAgainst('new-single')).rejects.toThrow(
      new NotFoundException('Post not found'),
    );
    expect(reports.manager.exists).not.toHaveBeenCalled();
    await expect(
      fileAgainst('9d000000-0000-4000-8000-0000000000bb'),
    ).rejects.toThrow(new NotFoundException('Post not found'));
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('offers the post reasons, outing and doxxing included', () => {
    expect(
      reasonsFor(ReportSubjectType.PersonaPost).map((reason) => reason.code),
    ).toEqual([
      'outing',
      'doxxing',
      'harassment',
      'hate_speech',
      'impersonation',
      'discrimination',
      'spam',
      'other',
    ]);
  });
});
