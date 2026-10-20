import { HttpException, NotFoundException } from '@nestjs/common';
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
import { playableTrackSql } from '../studio/studio-playlist-visibility';
import { categoryForReasonCode } from '../transparency/transparency-response';
import {
  Report,
  ReportSeverity,
  ReportSubjectType,
} from './entities/report.entity';
import { reasonsFor } from './reason-catalogue';
import { deriveSeverity } from './report-severity';
import { LISTENER_PLAYABLE_TRACK_SQL, ReportsService } from './reports.service';

const TRACK_ID = '9e000000-0000-4000-8000-0000000000aa';
const RELEASE_ID = '9e100000-0000-4000-8000-0000000000aa';

const failureOf = async (pending: Promise<unknown>): Promise<HttpException> => {
  try {
    await pending;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('Expected the call to throw');
};

describe('ReportsService: the Studio track subject', () => {
  let service: ReportsService;
  let playableTrackIds: Set<string>;
  let reports: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    manager: { exists: jest.Mock; query: jest.Mock };
  };

  beforeEach(async () => {
    playableTrackIds = new Set([TRACK_ID]);
    reports = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: object) => value),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) =>
        Promise.resolve({
          id: 'report-1',
          createdAt: new Date('2026-10-14T00:00:00.000Z'),
          ...(row as object),
        }),
      ),
      manager: {
        exists: jest.fn().mockResolvedValue(true),
        query: jest.fn((_sql: string, parameters: string[]) =>
          Promise.resolve(
            playableTrackIds.has(parameters[0]!) ? [{ id: parameters[0] }] : [],
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

  const fileAgainst = (
    subjectId: string,
    reasonCode:
      'hateful_lyrics' | 'copyright' | 'untagged_explicit' = 'hateful_lyrics',
    subjectType: ReportSubjectType = ReportSubjectType.StudioTrack,
  ) => service.create('reporter-1', { subjectType, subjectId, reasonCode });

  it('files against a playable track by its lowercased uuid', async () => {
    await fileAgainst(TRACK_ID.toUpperCase());

    expect(reports.manager.query).toHaveBeenCalledWith(
      LISTENER_PLAYABLE_TRACK_SQL,
      [TRACK_ID],
    );
    expect(reports.save).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: ReportSubjectType.StudioTrack,
        subjectId: TRACK_ID,
        severity: ReportSeverity.Medium,
      }),
    );
  });

  it('answers 404 for a slug without querying, and for a track a listener cannot play', async () => {
    await expect(fileAgainst('opening')).rejects.toThrow(
      new NotFoundException('Track not found'),
    );
    expect(reports.manager.query).not.toHaveBeenCalled();
    playableTrackIds.clear();
    await expect(fileAgainst(TRACK_ID)).rejects.toThrow(
      new NotFoundException('Track not found'),
    );
    expect(reports.save).not.toHaveBeenCalled();
  });

  // A draft release, a hidden persona, a track still uploading, a draft
  // episode and a withheld track all fail this one listener rule.
  it('checks the track through the listener playable rule', () => {
    expect(LISTENER_PLAYABLE_TRACK_SQL).toContain(
      playableTrackSql('track', 'release', 'persona'),
    );
    expect(LISTENER_PLAYABLE_TRACK_SQL).toContain('"track"."id" = $1');
  });

  it.each([
    [ReportSubjectType.StudioTrack, TRACK_ID],
    [ReportSubjectType.StudioRelease, RELEASE_ID],
  ])(
    'refuses a copyright report on %s with the claim form route, before any lookup',
    async (subjectType, subjectId) => {
      const failure = await failureOf(
        fileAgainst(subjectId, 'copyright', subjectType),
      );
      expect(failure.getStatus()).toBe(422);
      expect(failure.getResponse()).toEqual({
        statusCode: 422,
        code: 'studio_use_copyright_claim',
        message: 'Copyright claims have their own form.',
      });
      expect(reports.manager.query).not.toHaveBeenCalled();
      expect(reports.manager.exists).not.toHaveBeenCalled();
      expect(reports.save).not.toHaveBeenCalled();
    },
  );

  it('offers the track reasons in the contract order, copyright before other', () => {
    expect(
      reasonsFor(ReportSubjectType.StudioTrack).map((reason) => reason.code),
    ).toEqual([
      'hateful_lyrics',
      'untagged_explicit',
      'impersonation',
      'harassment',
      'outing',
      'spam',
      'copyright',
      'other',
    ]);
  });

  it('labels the two new reasons', () => {
    const labels = new Map(
      reasonsFor(ReportSubjectType.StudioTrack).map((reason) => [
        reason.code,
        reason.label,
      ]),
    );
    expect(labels.get('hateful_lyrics')).toBe('Hateful lyrics');
    expect(labels.get('untagged_explicit')).toBe('Explicit but not marked');
  });

  it('rates hateful lyrics like hate speech and an unmarked explicit track low', () => {
    expect(deriveSeverity('hateful_lyrics')).toBe(ReportSeverity.Medium);
    expect(deriveSeverity('untagged_explicit')).toBe(ReportSeverity.Low);
    expect(categoryForReasonCode('hateful_lyrics')).toBe('harassment');
    expect(categoryForReasonCode('untagged_explicit')).toBe('other');
  });

  it('files an unmarked explicit report against a release too', async () => {
    reports.manager.exists.mockResolvedValue(true);
    await fileAgainst(
      RELEASE_ID,
      'untagged_explicit',
      ReportSubjectType.StudioRelease,
    );
    expect(reports.save).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: ReportSubjectType.StudioRelease,
        reasonCode: 'untagged_explicit',
        severity: ReportSeverity.Low,
      }),
    );
  });
});
