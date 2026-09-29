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
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { Report, ReportSubjectType } from './entities/report.entity';
import { ReportsService } from './reports.service';

// ENG-446: a persona takedown is stored under the report's `subjectId` and
// read by the persona's lowercase uuid, so a persona report must carry exactly
// that uuid.
const PERSONA_ID = '5e000000-0000-4000-8000-0000000000aa';

describe('ReportsService: the persona (subprofile) subject', () => {
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
          createdAt: new Date('2026-09-29T00:00:00.000Z'),
          ...(row as object),
        }),
      ),
      // Only the persona with `PERSONA_ID` exists.
      manager: {
        exists: jest.fn((entity: unknown, options: { where: { id: string } }) =>
          Promise.resolve(
            entity === Subprofile && options.where.id === PERSONA_ID,
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
      subjectType: ReportSubjectType.Subprofile,
      subjectId,
      reasonCode: 'harassment',
    });

  it('files a report against an existing persona by its uuid', async () => {
    const report = await fileAgainst(PERSONA_ID);

    expect(report.subjectId).toBe(PERSONA_ID);
    expect(reports.save).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: ReportSubjectType.Subprofile,
        subjectId: PERSONA_ID,
      }),
    );
  });

  it('lowercases an uppercase uuid before the dedupe lookup and the insert', async () => {
    await fileAgainst(PERSONA_ID.toUpperCase());

    expect(reports.manager.exists).toHaveBeenCalledWith(Subprofile, {
      where: { id: PERSONA_ID },
    });
    expect(reports.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subjectId: PERSONA_ID }) as unknown,
      }),
    );
    expect(reports.save).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: PERSONA_ID }),
    );
  });

  it('refuses a slug with the unknown-persona 404 and never queries by it', async () => {
    await expect(fileAgainst('nightform')).rejects.toThrow(
      new NotFoundException('Subprofile not found'),
    );
    expect(reports.manager.exists).not.toHaveBeenCalled();
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('refuses a well-formed uuid that names no persona', async () => {
    await expect(
      fileAgainst('5e000000-0000-4000-8000-0000000000bb'),
    ).rejects.toThrow(new NotFoundException('Subprofile not found'));
    expect(reports.save).not.toHaveBeenCalled();
  });
});
