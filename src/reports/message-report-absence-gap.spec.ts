import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import { isInsideAbsenceGap } from '../messaging/group-absence-gap';
import { groupJoinHistoryFloorCoversPredicate } from '../messaging/group-join-history-floor';
import { MetricsService } from '../metrics/metrics.service';
import { Report, ReportSubjectType } from './entities/report.entity';
import { REPORT_NOT_PARTICIPANT_CODE, ReportsService } from './reports.service';

/**
 * SEC-25 applied to filing: a member who left a group and came back cannot
 * report, by id, a message posted while they were away. Their seat has no
 * join floor, so the floor check used to skip the seat entirely.
 */

const REPORTER_ID = '0a000000-0000-4000-8000-000000000001';
const SENDER_ID = '0a000000-0000-4000-8000-000000000002';
const MESSAGE_ID = '0e000000-0000-4000-8000-000000000001';
const GROUP_ID = '0d000000-0000-4000-8000-000000000001';

const SENT_AT = new Date('2026-11-10T12:00:00.000Z');

const EXPECTED_FLOOR_OR_GAP_CLAUSE = groupJoinHistoryFloorCoversPredicate(
  'message.created_at',
  'seat',
);

interface SeatState {
  absenceStartedAt: Date | null;
  absenceEndedAt: Date | null;
}

interface FloorQueryStub {
  withDeleted: () => FloorQueryStub;
  innerJoin: () => FloorQueryStub;
  where: (clause: string) => FloorQueryStub;
  andWhere: (clause: string) => FloorQueryStub;
  getExists: () => Promise<boolean>;
}

describe('ReportsService: message reports inside a group absence gap (SEC-25)', () => {
  let service: ReportsService;
  let reportsSave: jest.Mock;
  let conversationParticipants: { findOne: jest.Mock };
  let conversations: { findOne: jest.Mock };
  let messageQueryBuilder: jest.Mock<FloorQueryStub, []>;
  let seatState: SeatState;

  // Answers the one SQL clause it knows with the in-memory twin of the
  // absence-gap half of it, so the test reads the same rule the SQL does.
  function floorQuery(): FloorQueryStub {
    const clauses: string[] = [];
    const builder: FloorQueryStub = {
      withDeleted: () => builder,
      innerJoin: () => builder,
      where: (clause) => {
        clauses.push(clause);
        return builder;
      },
      andWhere: (clause) => {
        clauses.push(clause);
        return builder;
      },
      getExists: () => {
        let isCovered = true;
        for (const clause of clauses) {
          if (clause === 'message.id = :messageId') continue;
          if (clause !== EXPECTED_FLOOR_OR_GAP_CLAUSE) {
            throw new Error(`Unrecognised floor clause: ${clause}`);
          }
          isCovered = isCovered && isInsideAbsenceGap(SENT_AT, seatState);
        }
        return Promise.resolve(isCovered);
      },
    };
    return builder;
  }

  function seat(state: SeatState): void {
    seatState = state;
    conversationParticipants.findOne.mockResolvedValue({
      id: 'seat-1',
      leftAt: null,
      historyFloorAt: null,
      identityId: null,
      absenceStartedAt: state.absenceStartedAt,
      absenceEndedAt: state.absenceEndedAt,
    });
  }

  function reportMessage(): Promise<unknown> {
    return service.create(REPORTER_ID, {
      subjectType: ReportSubjectType.Message,
      subjectId: MESSAGE_ID,
      reasonCode: 'harassment',
    });
  }

  beforeEach(async () => {
    reportsSave = jest.fn((row: object) =>
      Promise.resolve({
        id: 'report-1',
        createdAt: new Date('2026-11-23T00:00:00.000Z'),
        ...row,
      }),
    );
    conversationParticipants = { findOne: jest.fn() };
    conversations = {
      findOne: jest.fn().mockResolvedValue({
        id: GROUP_ID,
        kind: ConversationKind.Group,
        isOfficial: false,
      }),
    };
    messageQueryBuilder = jest.fn(floorQuery);
    seatState = { absenceStartedAt: null, absenceEndedAt: null };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        {
          provide: getRepositoryToken(Report),
          useValue: {
            save: reportsSave,
            findOne: jest.fn().mockResolvedValue(null),
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn((value: object) => value),
          },
        },
        {
          provide: getRepositoryToken(Message),
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: MESSAGE_ID,
              conversationId: GROUP_ID,
              senderId: SENDER_ID,
              body: 'posted while they were away',
              createdAt: SENT_AT,
              editedAt: null,
              deletedAt: null,
              replyToId: null,
              kind: 'text',
              attachment: null,
            }),
            createQueryBuilder: messageQueryBuilder,
          },
        },
        {
          provide: getRepositoryToken(HousingListing),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(EventPhoto),
          useValue: { findOne: jest.fn() },
        },
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: conversationParticipants,
        },
        {
          provide: getRepositoryToken(ContentModeration),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: IdentitiesService, useValue: { getById: jest.fn() } },
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

  it('refuses a message posted inside the seat’s absence gap, like an outsider', async () => {
    seat({
      absenceStartedAt: new Date('2026-11-09T12:00:00.000Z'),
      absenceEndedAt: new Date('2026-11-11T12:00:00.000Z'),
    });

    const outcome = await reportMessage().then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(ForbiddenException);
    if (outcome instanceof ForbiddenException) {
      expect(outcome.getResponse()).toMatchObject({
        code: REPORT_NOT_PARTICIPANT_CODE,
      });
    }
    expect(reportsSave).not.toHaveBeenCalled();
  });

  it('files a message posted outside the absence gap', async () => {
    seat({
      absenceStartedAt: new Date('2026-11-01T12:00:00.000Z'),
      absenceEndedAt: new Date('2026-11-02T12:00:00.000Z'),
    });

    await reportMessage();

    expect(reportsSave).toHaveBeenCalledTimes(1);
  });

  it('runs no floor lookup for a seat with neither a floor nor a gap', async () => {
    seat({ absenceStartedAt: null, absenceEndedAt: null });

    await reportMessage();

    expect(messageQueryBuilder).not.toHaveBeenCalled();
    expect(reportsSave).toHaveBeenCalledTimes(1);
  });
});
