import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import { MetricsService } from '../metrics/metrics.service';
import { Report, ReportSubjectType } from './entities/report.entity';
import { reasonsFor } from './reason-catalogue';
import { MailboxIdentitySnapshotEvidence } from './report-evidence';
import { toReportDTO } from './report-response';
import { ReportsService } from './reports.service';

const CUSTOMER_ID = '0a000000-0000-4000-8000-000000000001';
const OWNER_ID = '0a000000-0000-4000-8000-000000000002';
const CO_MANAGER_ID = '0a000000-0000-4000-8000-000000000003';
const LISTING_ID = '0b000000-0000-4000-8000-000000000001';
const LISTING_IDENTITY_ID = '0c000000-0000-4000-8000-000000000001';
const PROFILE_IDENTITY_ID = '0c000000-0000-4000-8000-000000000002';
const THREAD_ID = '0d000000-0000-4000-8000-000000000001';

function identityRow(overrides: Partial<Identity> = {}): Identity {
  return {
    id: LISTING_IDENTITY_ID,
    kind: IdentityKind.Listing,
    userId: null,
    subprofileId: null,
    listingId: LISTING_ID,
    companyId: null,
    shouldShowStaffNames: true,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ReportsService: the identity subject', () => {
  let service: ReportsService;
  let reports: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
  };
  let conversationParticipants: {
    findOne: jest.Mock;
    find: jest.Mock;
    query: jest.Mock;
  };
  let identities: {
    getById: jest.Mock;
    staffUserIds: jest.Mock;
    describeIdentities: jest.Mock;
  };

  beforeEach(async () => {
    reports = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: object) => value),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) =>
        Promise.resolve({
          id: 'report-1',
          createdAt: new Date('2026-09-22T00:00:00.000Z'),
          ...(row as object),
        }),
      ),
    };
    conversationParticipants = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      // The customer-thread lookup. Default: the reporter holds a customer
      // seat in one direct thread with the identity.
      query: jest.fn().mockResolvedValue([{ conversationId: THREAD_ID }]),
    };
    identities = {
      getById: jest.fn().mockResolvedValue(identityRow()),
      staffUserIds: jest.fn().mockResolvedValue([OWNER_ID, CO_MANAGER_ID]),
      describeIdentities: jest.fn().mockResolvedValue(
        new Map([
          [
            LISTING_IDENTITY_ID,
            {
              displayName: 'Cafe Lisboa',
              handle: 'cafe-lisboa',
              avatarUrl: null,
            },
          ],
        ]),
      ),
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

  const fileAgainst = (reporterId: string | null, subjectId: string) =>
    service.create(reporterId, {
      subjectType: ReportSubjectType.Identity,
      subjectId,
      reasonCode: 'harassment',
    });

  const firstSavedRow = (): unknown =>
    (reports.save.mock.calls as unknown[][])[0]![0];

  const savedSnapshot = (): MailboxIdentitySnapshotEvidence => {
    const saved = firstSavedRow() as { evidence: unknown[] };
    return saved.evidence.find(
      (entry) => (entry as { kind?: string }).kind === 'mailbox_identity',
    ) as MailboxIdentitySnapshotEvidence;
  };

  it('files a customer report with a snapshot naming the thread and the staff', async () => {
    const dto = await fileAgainst(CUSTOMER_ID, LISTING_IDENTITY_ID);

    expect(dto.subjectType).toBe('identity');
    expect(dto.subjectId).toBe(LISTING_IDENTITY_ID);
    const saved = firstSavedRow() as {
      subjectType: string;
      reporterId: string;
    };
    expect(saved.subjectType).toBe('identity');
    expect(saved.reporterId).toBe(CUSTOMER_ID);
    expect(savedSnapshot()).toEqual({
      kind: 'mailbox_identity',
      identityId: LISTING_IDENTITY_ID,
      identityKind: 'listing',
      ownerEntityId: LISTING_ID,
      displayName: 'Cafe Lisboa',
      conversationId: THREAD_ID,
      staffUserIds: [OWNER_ID, CO_MANAGER_ID],
      capturedAt: expect.any(String),
    });
    expect(conversationParticipants.query).toHaveBeenCalledWith(
      expect.any(String),
      [CUSTOMER_ID, LISTING_IDENTITY_ID],
    );
  });

  describe('refuses with one identical 404 body', () => {
    const refusalOf = async (
      reporterId: string | null,
      subjectId: string,
    ): Promise<unknown> => {
      const error: unknown = await fileAgainst(reporterId, subjectId).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(NotFoundException);
      return (error as HttpException).getResponse();
    };

    it('for a member with no thread, a signed-out caller, a profile identity and a non-uuid', async () => {
      conversationParticipants.query.mockResolvedValueOnce([]);
      const noThread = await refusalOf(CUSTOMER_ID, LISTING_IDENTITY_ID);

      const signedOut = await refusalOf(null, LISTING_IDENTITY_ID);

      identities.getById.mockResolvedValueOnce(
        identityRow({
          id: PROFILE_IDENTITY_ID,
          kind: IdentityKind.Profile,
          userId: OWNER_ID,
          listingId: null,
        }),
      );
      const profileIdentity = await refusalOf(CUSTOMER_ID, PROFILE_IDENTITY_ID);

      const notUuid = await refusalOf(CUSTOMER_ID, 'cafe-lisboa');

      identities.getById.mockResolvedValueOnce(null);
      const unknownIdentity = await refusalOf(CUSTOMER_ID, LISTING_IDENTITY_ID);

      for (const body of [
        signedOut,
        profileIdentity,
        notUuid,
        unknownIdentity,
      ]) {
        expect(body).toEqual(noThread);
      }
      expect(reports.save).not.toHaveBeenCalled();
    });

    it('never reads an identity for a non-uuid or a signed-out caller', async () => {
      await fileAgainst(null, LISTING_IDENTITY_ID).catch(() => undefined);
      await fileAgainst(CUSTOMER_ID, 'not-a-uuid').catch(() => undefined);
      expect(identities.getById).not.toHaveBeenCalled();
      expect(conversationParticipants.query).not.toHaveBeenCalled();
    });
  });

  it('refuses a staff member of the identity with a 403', async () => {
    const error: unknown = await fileAgainst(
      CO_MANAGER_ID,
      LISTING_IDENTITY_ID,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(reports.save).not.toHaveBeenCalled();
    // Refused as staff before the thread is ever looked up, so a member who
    // was a customer before joining the team is refused too.
    expect(conversationParticipants.query).not.toHaveBeenCalled();
  });

  it('lets a former customer file, since the thread lookup ignores left and cleared seats', async () => {
    const dto = await fileAgainst(CUSTOMER_ID, LISTING_IDENTITY_ID);

    expect(dto.subjectType).toBe('identity');
    const [threadSql] = conversationParticipants.query.mock.calls[0] as [
      string,
    ];
    expect(threadSql).not.toMatch(/left_at|cleared_at|removed_at/);
  });

  it('never carries a staff id in the reporter-facing DTO', async () => {
    const dto = await fileAgainst(CUSTOMER_ID, LISTING_IDENTITY_ID);
    const savedRow = firstSavedRow() as Report;
    const reread = toReportDTO({
      ...savedRow,
      id: 'report-1',
      createdAt: new Date('2026-09-22T00:00:00.000Z'),
    });

    for (const serialized of [JSON.stringify(dto), JSON.stringify(reread)]) {
      expect(serialized).not.toContain(OWNER_ID);
      expect(serialized).not.toContain(CO_MANAGER_ID);
      expect(serialized).not.toContain('staffUserIds');
      expect(serialized).not.toContain('mailbox_identity');
    }
  });

  it('offers the business set plus the thread codes, other last', () => {
    expect(
      reasonsFor(ReportSubjectType.Identity).map((option) => option.code),
    ).toEqual([
      'harassment',
      'hate_speech',
      'unwanted_contact',
      'housing_scam',
      'spam',
      'venue_safety',
      'discrimination',
      'other',
    ]);
  });
});
