import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { captureCommunityGiftForReport } from '../community-badges/community-gift-report';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import { MetricsService } from '../metrics/metrics.service';
import { Report, ReportSubjectType } from './entities/report.entity';
import { reasonsFor } from './reason-catalogue';
import {
  COMMUNITY_GIFT_SNAPSHOT_TYPE,
  type CommunityGiftSnapshotEvidence,
} from './report-evidence';
import {
  REPORT_REASON_NOT_OFFERED_CODE,
  ReportsService,
} from './reports.service';

jest.mock('../community-badges/community-gift-report', () => ({
  captureCommunityGiftForReport: jest.fn(),
}));

const captureMock = captureCommunityGiftForReport as jest.MockedFunction<
  typeof captureCommunityGiftForReport
>;

// Community badges: a gift report names one gift by its uuid.
const GIFT_ID = '0d000000-0000-4000-8000-0000000000aa';
const RECIPIENT_ID = 'recipient-1';

const giftSnapshot: CommunityGiftSnapshotEvidence = {
  type: COMMUNITY_GIFT_SNAPSHOT_TYPE,
  giftId: GIFT_ID,
  communityId: 'community-1',
  giftKey: 'heart',
  note: 'see you',
  senderId: 'sender-1',
  sentAt: '2026-11-20T10:00:00.000Z',
  snapshotAt: '2026-11-21T00:00:00.000Z',
};

/** The reason code a rejected filing answered with. */
async function codeOfRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
  throw new Error('Expected the filing to reject');
}

describe('ReportsService: the community gift subject', () => {
  let service: ReportsService;
  let reports: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    manager: { query: jest.Mock };
  };

  beforeEach(async () => {
    captureMock.mockReset();
    captureMock.mockResolvedValue(giftSnapshot);
    reports = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: object) => value),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) =>
        Promise.resolve({
          id: 'report-1',
          createdAt: new Date('2026-11-21T00:00:00.000Z'),
          ...(row as object),
        }),
      ),
      manager: { query: jest.fn().mockResolvedValue([]) },
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

  const giftReport = (
    subjectId: string = GIFT_ID,
    reasonCode: 'harassment' | 'copyright' = 'harassment',
  ) => ({
    subjectType: ReportSubjectType.CommunityGift,
    subjectId,
    reasonCode,
  });

  it('keeps the snapshot as evidence and lowercases the gift id', async () => {
    await service.create(RECIPIENT_ID, giftReport(GIFT_ID.toUpperCase()));

    expect(captureMock).toHaveBeenCalledWith(
      reports.manager,
      GIFT_ID,
      RECIPIENT_ID,
      expect.any(Date),
    );
    expect(reports.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subjectId: GIFT_ID }),
      }),
    );
    const created = (reports.create.mock.calls as unknown[][])[0]?.[0] as {
      subjectId: string;
      evidence: Array<Record<string, unknown>>;
    };
    expect(created.subjectId).toBe(GIFT_ID);
    expect(created.evidence[created.evidence.length - 1]).toEqual(giftSnapshot);
  });

  it('files a report on a gift staff already removed', async () => {
    // The capture reads removed gifts too, so a removed gift still snapshots.
    const removedGiftSnapshot: CommunityGiftSnapshotEvidence = {
      ...giftSnapshot,
      note: 'the note staff took down',
    };
    captureMock.mockResolvedValue(removedGiftSnapshot);

    await service.create(RECIPIENT_ID, giftReport());

    expect(reports.save).toHaveBeenCalled();
    const created = (reports.create.mock.calls as unknown[][])[0]?.[0] as {
      subjectId: string;
      evidence: Array<Record<string, unknown>>;
    };
    expect(created.subjectId).toBe(GIFT_ID);
    expect(created.evidence[created.evidence.length - 1]).toEqual(
      removedGiftSnapshot,
    );
  });

  it('answers gift_not_found to anyone but the recipient', async () => {
    captureMock.mockResolvedValue(null);

    expect(await codeOfRejection(service.create('u3', giftReport()))).toBe(
      'gift_not_found',
    );
    expect(captureMock).toHaveBeenCalledWith(
      reports.manager,
      GIFT_ID,
      'u3',
      expect.any(Date),
    );
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('answers gift_not_found to a malformed id and to a signed-out filer', async () => {
    expect(
      await codeOfRejection(service.create(RECIPIENT_ID, giftReport('gift-1'))),
    ).toBe('gift_not_found');
    expect(await codeOfRejection(service.create(null, giftReport()))).toBe(
      'gift_not_found',
    );

    expect(captureMock).not.toHaveBeenCalled();
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('offers exactly the seven gift reasons', () => {
    expect(
      reasonsFor(ReportSubjectType.CommunityGift).map((reason) => reason.code),
    ).toEqual([
      'harassment',
      'hate_speech',
      'discrimination',
      'outing',
      'doxxing',
      'spam',
      'other',
    ]);
  });

  it('refuses a reason the gift subject does not offer', async () => {
    expect(
      await codeOfRejection(
        service.create(RECIPIENT_ID, giftReport(GIFT_ID, 'copyright')),
      ),
    ).toBe(REPORT_REASON_NOT_OFFERED_CODE);
    expect(captureMock).not.toHaveBeenCalled();
  });
});
