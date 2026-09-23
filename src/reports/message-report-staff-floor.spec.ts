import { ForbiddenException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import { MetricsService } from '../metrics/metrics.service';
import { Report, ReportSubjectType } from './entities/report.entity';
import { REPORT_NOT_PARTICIPANT_CODE, ReportsService } from './reports.service';

const REPORTER_ID = '0a000000-0000-4000-8000-000000000001';
const SENDER_ID = '0a000000-0000-4000-8000-000000000002';
const MESSAGE_ID = '0e000000-0000-4000-8000-000000000001';
const THREAD_ID = '0d000000-0000-4000-8000-000000000001';
const SEAT_IDENTITY_ID = '0c000000-0000-4000-8000-000000000001';

const SENT_AT = new Date('2026-09-10T12:00:00.000Z');
const FLOOR_AFTER_SEND = new Date('2026-09-11T12:00:00.000Z');
const FLOOR_BEFORE_SEND = new Date('2026-09-09T12:00:00.000Z');

/**
 * Task 13h review (M1): a mailbox staff member must not be able to report,
 * by id, a message their seat's history floor hides from them. Refused with
 * the exact refusal a message outside the conversation gets.
 */
describe('ReportsService: message reports behind a mailbox staff floor', () => {
  let service: ReportsService;
  let reports: { save: jest.Mock };
  let conversationParticipants: { findOne: jest.Mock };
  let conversations: { findOne: jest.Mock };
  let identities: { getById: jest.Mock };

  const seat = (options: {
    identityKind: IdentityKind;
    clearedAt: Date | null;
    conversationKind?: ConversationKind;
    isOfficial?: boolean;
  }) => {
    conversationParticipants.findOne.mockResolvedValue({
      id: 'seat-1',
      leftAt: null,
      clearedAt: options.clearedAt,
      identityId: SEAT_IDENTITY_ID,
    });
    identities.getById.mockResolvedValue({
      id: SEAT_IDENTITY_ID,
      kind: options.identityKind,
    });
    conversations.findOne.mockResolvedValue({
      id: THREAD_ID,
      kind: options.conversationKind ?? ConversationKind.Direct,
      isOfficial: options.isOfficial ?? false,
    });
  };

  const reportMessage = () =>
    service.create(REPORTER_ID, {
      subjectType: ReportSubjectType.Message,
      subjectId: MESSAGE_ID,
      reasonCode: 'harassment',
    });

  const refusalOf = async (): Promise<unknown> => {
    const error: unknown = await reportMessage().catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as HttpException).getResponse();
  };

  beforeEach(async () => {
    reports = {
      save: jest.fn((row: unknown) =>
        Promise.resolve({
          id: 'report-1',
          createdAt: new Date('2026-09-22T00:00:00.000Z'),
          ...(row as object),
        }),
      ),
    };
    conversationParticipants = { findOne: jest.fn() };
    conversations = { findOne: jest.fn() };
    identities = { getById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        {
          provide: getRepositoryToken(Report),
          useValue: {
            ...reports,
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
              conversationId: THREAD_ID,
              senderId: SENDER_ID,
              body: 'before the floor',
              createdAt: SENT_AT,
              editedAt: null,
              deletedAt: null,
              replyToId: null,
              kind: 'text',
              attachment: null,
            }),
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
        { provide: IdentitiesService, useValue: identities },
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

  it('refuses a staff seat a message at or before its floor, exactly as an outsider is refused', async () => {
    conversationParticipants.findOne.mockResolvedValueOnce(null);
    const outsiderRefusal = await refusalOf();

    seat({ identityKind: IdentityKind.Listing, clearedAt: FLOOR_AFTER_SEND });
    const staffRefusal = await refusalOf();

    expect(staffRefusal).toEqual(outsiderRefusal);
    expect(staffRefusal).toMatchObject({ code: REPORT_NOT_PARTICIPANT_CODE });
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('refuses a message sent at the floor instant itself', async () => {
    seat({ identityKind: IdentityKind.Company, clearedAt: SENT_AT });
    await refusalOf();
  });

  it('lets a staff seat report a message sent after its floor', async () => {
    seat({
      identityKind: IdentityKind.Subprofile,
      clearedAt: FLOOR_BEFORE_SEND,
    });
    await expect(reportMessage()).resolves.toMatchObject({
      subjectType: 'message',
    });
  });

  it.each([
    [
      'a personal seat after its own clear chat',
      IdentityKind.Profile,
      ConversationKind.Direct,
      false,
    ],
    [
      'a customer seat in a mailbox thread',
      IdentityKind.Profile,
      ConversationKind.Direct,
      false,
    ],
    [
      'a group seat after clear chat',
      IdentityKind.Profile,
      ConversationKind.Group,
      false,
    ],
    [
      'a business seat in a group thread',
      IdentityKind.Listing,
      ConversationKind.Group,
      false,
    ],
    [
      'a business seat in an official thread',
      IdentityKind.Listing,
      ConversationKind.Direct,
      true,
    ],
  ])(
    'still files for %s',
    async (_label, identityKind, conversationKind, isOfficial) => {
      seat({
        identityKind,
        clearedAt: FLOOR_AFTER_SEND,
        conversationKind,
        isOfficial,
      });
      await expect(reportMessage()).resolves.toMatchObject({
        subjectType: 'message',
      });
    },
  );

  it('runs no extra lookup for a seat with no floor', async () => {
    seat({ identityKind: IdentityKind.Listing, clearedAt: null });
    await expect(reportMessage()).resolves.toMatchObject({
      subjectType: 'message',
    });
    expect(identities.getById).not.toHaveBeenCalled();
    expect(conversations.findOne).not.toHaveBeenCalled();
  });
});
