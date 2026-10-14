import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import { MetricsService } from '../metrics/metrics.service';
import {
  StudioRelease,
  StudioReleaseStatus,
} from '../studio/entities/studio-release.entity';
import {
  Report,
  ReportSeverity,
  ReportSubjectType,
} from './entities/report.entity';
import { reasonsFor } from './reason-catalogue';
import { deriveSeverity } from './report-severity';
import { ReportsService } from './reports.service';

// Studio v1: a release report names a release that is live on Studio.
const RELEASE_ID = '9c000000-0000-4000-8000-0000000000aa';
// Studio v3: a scheduled release is reportable too.
const SCHEDULED_RELEASE_ID = '9c000000-0000-4000-8000-0000000000cc';
const DRAFT_RELEASE_ID = '9c000000-0000-4000-8000-0000000000dd';
const TAKEN_DOWN_RELEASE_ID = '9c000000-0000-4000-8000-0000000000ee';
const RELEASE_STATUS_BY_ID = new Map<string, StudioReleaseStatus>([
  [RELEASE_ID, StudioReleaseStatus.Published],
  [SCHEDULED_RELEASE_ID, StudioReleaseStatus.Scheduled],
  [DRAFT_RELEASE_ID, StudioReleaseStatus.Draft],
  [TAKEN_DOWN_RELEASE_ID, StudioReleaseStatus.TakenDown],
]);
const REPORTABLE_STATUSES = [
  StudioReleaseStatus.Published,
  StudioReleaseStatus.Scheduled,
];

describe('ReportsService: the Studio release subject', () => {
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
          createdAt: new Date('2026-10-08T00:00:00.000Z'),
          ...(row as object),
        }),
      ),
      // The four releases of `RELEASE_STATUS_BY_ID` exist, one per status.
      manager: {
        exists: jest.fn(
          (
            entity: unknown,
            options: {
              where: {
                id: string;
                status: FindOperator<StudioReleaseStatus[]>;
              };
            },
          ) => {
            const status = RELEASE_STATUS_BY_ID.get(options.where.id);
            const allowedStatuses = options.where.status.value as
              StudioReleaseStatus[] | undefined;
            return Promise.resolve(
              entity === StudioRelease &&
                status !== undefined &&
                (allowedStatuses ?? []).includes(status),
            );
          },
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
      subjectType: ReportSubjectType.StudioRelease,
      subjectId,
      reasonCode: 'impersonation',
    });

  it('files against a published release by its lowercased uuid', async () => {
    await fileAgainst(RELEASE_ID.toUpperCase());
    expect(reports.manager.exists).toHaveBeenCalledWith(StudioRelease, {
      where: { id: RELEASE_ID, status: expect.any(FindOperator) },
    });
    const [[, options]] = reports.manager.exists.mock.calls as [
      [unknown, { where: { status: FindOperator<StudioReleaseStatus[]> } }],
    ];
    expect(options.where.status.type).toBe('in');
    expect(options.where.status.value).toEqual(REPORTABLE_STATUSES);
    expect(reports.save).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: ReportSubjectType.StudioRelease,
        subjectId: RELEASE_ID,
      }),
    );
  });

  it('answers 404 for a slug without querying, and for a release that is not live', async () => {
    await expect(fileAgainst('lisbon-at-four')).rejects.toThrow(
      new NotFoundException('Release not found'),
    );
    expect(reports.manager.exists).not.toHaveBeenCalled();
    await expect(
      fileAgainst('9c000000-0000-4000-8000-0000000000bb'),
    ).rejects.toThrow(new NotFoundException('Release not found'));
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('files against a scheduled release its listeners can already see', async () => {
    await fileAgainst(SCHEDULED_RELEASE_ID);
    expect(reports.save).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: ReportSubjectType.StudioRelease,
        subjectId: SCHEDULED_RELEASE_ID,
      }),
    );
  });

  it.each([DRAFT_RELEASE_ID, TAKEN_DOWN_RELEASE_ID])(
    'answers 404 for a draft or taken-down release: %s',
    async (releaseId) => {
      await expect(fileAgainst(releaseId)).rejects.toThrow(
        new NotFoundException('Release not found'),
      );
      expect(reports.save).not.toHaveBeenCalled();
    },
  );

  it('offers the release reason set', () => {
    expect(
      reasonsFor(ReportSubjectType.StudioRelease).map((reason) => reason.code),
    ).toEqual([
      'outing',
      'doxxing',
      'harassment',
      'hate_speech',
      'impersonation',
      'copyright',
      'discrimination',
      'spam',
      'other',
    ]);
  });

  it('rates a copyright report at medium severity', () => {
    expect(deriveSeverity('copyright')).toBe(ReportSeverity.Medium);
  });
});
