import { ConflictException } from '@nestjs/common';
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
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from './entities/report.entity';
import {
  FOLLOW_UP_HEADING_PATTERN,
  REPEATED_ACCOUNT_SQL,
} from './report-follow-up-detail';
import {
  CreateReportInput,
  REPORT_FOLLOW_UP_LIMIT_CODE,
  ReportsService,
} from './reports.service';

/**
 * PRD-510: a repeat filing with the same reason while the first report is
 * open adds its new account and evidence to that open report, and the answer
 * names what happened.
 */

const REPORTER_ID = 'reporter-1';

type SetValues = Record<string, () => string>;
type SetParameters = Record<string, unknown>;

interface UpdateQueryBuilderStub {
  update: jest.Mock<UpdateQueryBuilderStub, [unknown]>;
  set: jest.Mock<UpdateQueryBuilderStub, [SetValues]>;
  where: jest.Mock<UpdateQueryBuilderStub, [string, SetParameters]>;
  andWhere: jest.Mock<UpdateQueryBuilderStub, [string, SetParameters?]>;
  setParameters: jest.Mock<UpdateQueryBuilderStub, [SetParameters]>;
  execute: jest.Mock<Promise<{ affected: number }>, []>;
}

function updateQueryBuilderStub(affected: number): UpdateQueryBuilderStub {
  const queryBuilder: UpdateQueryBuilderStub = {
    update: jest.fn<UpdateQueryBuilderStub, [unknown]>(),
    set: jest.fn<UpdateQueryBuilderStub, [SetValues]>(),
    where: jest.fn<UpdateQueryBuilderStub, [string, SetParameters]>(),
    andWhere: jest.fn<UpdateQueryBuilderStub, [string, SetParameters?]>(),
    setParameters: jest.fn<UpdateQueryBuilderStub, [SetParameters]>(),
    execute: jest
      .fn<Promise<{ affected: number }>, []>()
      .mockResolvedValue({ affected }),
  };
  queryBuilder.update.mockReturnValue(queryBuilder);
  queryBuilder.set.mockReturnValue(queryBuilder);
  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);
  queryBuilder.setParameters.mockReturnValue(queryBuilder);
  return queryBuilder;
}

interface ReportsRepositoryStub {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  count: jest.Mock;
  manager: { findOne: jest.Mock };
  createQueryBuilder: jest.Mock<UpdateQueryBuilderStub, []>;
}

function openReport(overrides: Partial<Report> = {}): Report {
  return Object.assign(new Report(), {
    id: 'report-open',
    subjectType: ReportSubjectType.Post,
    subjectId: 'post-1',
    reasonCode: 'harassment',
    detail: 'They replied to every one of my posts with slurs.',
    anonymous: false,
    contactEmail: null,
    anonymousReporterKey: null,
    evidence: [{ type: 'url', value: 'https://example.com/first' }],
    severity: ReportSeverity.High,
    slaDueAt: new Date('2026-11-23T12:00:00.000Z'),
    status: ReportStatus.Open,
    reporterId: REPORTER_ID,
    createdAt: new Date('2026-11-23T08:00:00.000Z'),
    ...overrides,
  });
}

function repeatFiling(
  overrides: Partial<CreateReportInput> = {},
): CreateReportInput {
  return {
    subjectType: ReportSubjectType.Post,
    subjectId: 'post-1',
    reasonCode: 'harassment',
    ...overrides,
  };
}

describe('ReportsService: follow-ups on an open report (PRD-510)', () => {
  let service: ReportsService;
  let reports: ReportsRepositoryStub;
  let updateQueryBuilder: UpdateQueryBuilderStub;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    updateQueryBuilder = updateQueryBuilderStub(1);
    reports = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((values: object) => values),
      save: jest.fn((row: object) =>
        Promise.resolve({
          id: 'report-new',
          createdAt: new Date('2026-11-23T09:00:00.000Z'),
          ...row,
        }),
      ),
      count: jest.fn().mockResolvedValue(0),
      manager: { findOne: jest.fn().mockResolvedValue(null) },
      createQueryBuilder: jest.fn(() => updateQueryBuilder),
    };
    emitter = { emit: jest.fn() };

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
        { provide: EventEmitter2, useValue: emitter },
        {
          provide: MetricsService,
          useValue: { incrementReportFloodRefusal: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  function setValues(): SetValues {
    const values = updateQueryBuilder.set.mock.calls[0]?.[0];
    if (!values) throw new Error('the open report was never updated');
    return values;
  }

  function setParameters(): SetParameters {
    const parameters = updateQueryBuilder.setParameters.mock.calls[0]?.[0];
    if (!parameters) throw new Error('the open report was never updated');
    return parameters;
  }

  it('appends the new account and only the new evidence to the open report', async () => {
    reports.findOne
      .mockResolvedValueOnce(openReport())
      .mockResolvedValueOnce(openReport({ detail: 'updated on disk' }));

    const result = await service.create(
      REPORTER_ID,
      repeatFiling({
        detail: 'Now they are sending the same thing in my messages.',
        evidence: [
          { type: 'url', value: 'https://example.com/first' },
          { type: 'url', value: 'https://example.com/second' },
        ],
      }),
    );

    expect(result).toMatchObject({
      id: 'report-open',
      filing: 'details_added',
    });
    const parameters = setParameters();
    expect(parameters.followUpText).toEqual(
      expect.stringContaining(
        'Now they are sending the same thing in my messages.',
      ),
    );
    expect(parameters.followUpText).toEqual(
      expect.stringContaining('Added by the reporter on'),
    );
    expect(parameters.followUpEvidence).toBe(
      JSON.stringify([{ type: 'url', value: 'https://example.com/second' }]),
    );
    // Guarded on the report still being open, and nothing new was filed.
    expect(updateQueryBuilder.andWhere).toHaveBeenCalledWith(
      'status = :openStatus',
      { openStatus: ReportStatus.Open },
    );
    expect(reports.save).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('answers a retry carrying nothing new as already open and writes nothing', async () => {
    reports.findOne.mockResolvedValueOnce(openReport());

    const result = await service.create(
      REPORTER_ID,
      repeatFiling({
        detail: 'They replied to every one of my posts with slurs.',
        evidence: [{ type: 'url', value: 'https://example.com/first' }],
      }),
    );

    expect(result).toMatchObject({ id: 'report-open', filing: 'already_open' });
    expect(reports.createQueryBuilder).not.toHaveBeenCalled();
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('appends a short follow-up that only appears inside the first account', async () => {
    reports.findOne
      .mockResolvedValueOnce(openReport())
      .mockResolvedValueOnce(openReport({ detail: 'updated on disk' }));

    const result = await service.create(
      REPORTER_ID,
      repeatFiling({ detail: 'slurs' }),
    );

    expect(result).toMatchObject({ filing: 'details_added' });
    expect(setParameters().followUpText).toEqual(
      expect.stringMatching(/^Added by the reporter on .+:\nslurs$/),
    );
  });

  it('answers a retry of an account added earlier as already open', async () => {
    reports.findOne.mockResolvedValueOnce(
      openReport({
        detail:
          'They replied to every one of my posts with slurs.\n\n' +
          'Added by the reporter on 2026-11-23T09:30:00.000Z:\n' +
          'It happened again tonight.',
      }),
    );

    const result = await service.create(
      REPORTER_ID,
      repeatFiling({ detail: '  It happened again tonight.  ' }),
    );

    expect(result).toMatchObject({ id: 'report-open', filing: 'already_open' });
    expect(reports.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('makes the open report anonymous when the follow-up asks for it', async () => {
    reports.findOne.mockResolvedValueOnce(openReport());

    await service.create(REPORTER_ID, repeatFiling({ anonymous: true }));

    expect(setValues().anonymous?.()).toBe('TRUE');
  });

  it('keeps an anonymous open report anonymous when the follow-up is filed by name', async () => {
    reports.findOne.mockResolvedValueOnce(openReport({ anonymous: true }));

    await service.create(
      REPORTER_ID,
      repeatFiling({ anonymous: false, detail: 'It happened again tonight.' }),
    );

    expect(setValues().anonymous?.()).toBe('anonymous');
  });

  it('answers already open when a concurrent identical tap added the same text first', async () => {
    // The guarded UPDATE finds the text already on the row and touches
    // nothing, and the report is still open.
    updateQueryBuilder = updateQueryBuilderStub(0);
    reports.findOne
      .mockResolvedValueOnce(openReport())
      .mockResolvedValueOnce(openReport());

    const result = await service.create(
      REPORTER_ID,
      repeatFiling({ detail: 'It happened again tonight.' }),
    );

    expect(result).toMatchObject({ id: 'report-open', filing: 'already_open' });
    expect(updateQueryBuilder.andWhere).toHaveBeenCalledWith(
      `(NOT (${REPEATED_ACCOUNT_SQL}))`,
    );
    expect(setParameters().followUpHeadingPattern).toBe(
      FOLLOW_UP_HEADING_PATTERN,
    );
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('answers already open when the evidence it brought changed nothing on the row', async () => {
    // The row as re-read after the UPDATE holds exactly what this filing
    // found: a concurrent tap had already added the same link.
    reports.findOne
      .mockResolvedValueOnce(openReport())
      .mockResolvedValueOnce(openReport());

    const result = await service.create(
      REPORTER_ID,
      repeatFiling({
        evidence: [{ type: 'url', value: 'https://example.com/second' }],
      }),
    );

    expect(result).toMatchObject({ id: 'report-open', filing: 'already_open' });
    expect(updateQueryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('jsonb_array_elements'),
    );
  });

  it('files a fresh report when the open one closed before the follow-up landed', async () => {
    updateQueryBuilder = updateQueryBuilderStub(0);
    reports.findOne.mockResolvedValueOnce(openReport());

    const result = await service.create(
      REPORTER_ID,
      repeatFiling({ detail: 'It happened again tonight.' }),
    );

    expect(result).toMatchObject({ id: 'report-new', filing: 'filed' });
    expect(reports.save).toHaveBeenCalledTimes(1);
  });

  it('refuses with a reason code once the open report holds all it can', async () => {
    reports.findOne.mockResolvedValueOnce(
      openReport({ detail: 'x'.repeat(19_990) }),
    );

    const outcome = await service
      .create(
        REPORTER_ID,
        repeatFiling({ detail: 'One more thing they said tonight.' }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(outcome).toBeInstanceOf(ConflictException);
    if (outcome instanceof ConflictException) {
      expect(outcome.getResponse()).toMatchObject({
        code: REPORT_FOLLOW_UP_LIMIT_CODE,
      });
    }
    expect(reports.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('never folds a signed-out filing into anyone’s open report', async () => {
    reports.findOne.mockResolvedValue(openReport());

    const result = await service.create(
      null,
      repeatFiling({ detail: 'I saw this happen at the event.' }),
    );

    expect(result.filing).toBe('filed');
    expect(reports.createQueryBuilder).not.toHaveBeenCalled();
  });
});
