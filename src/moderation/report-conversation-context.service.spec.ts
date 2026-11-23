import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IdentitiesService } from '../identities/identities.service';
import { Message } from '../messaging/entities/message.entity';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { ModAuditService } from './mod-audit.service';
import { REPORT_ABOUT_ACTOR_CODE } from './report-about-actor';
import { ReportConversationContextService } from './report-conversation-context.service';

/**
 * SEC-31: the staff conversation viewer refuses the staff member who sent the
 * reported message, before any of the conversation is read or any viewing row
 * is written.
 */

const REPORT_ID = '3d2f8a10-9c4b-4d6e-8f01-2a3b4c5d6e7f';
const MESSAGE_ID = '7f1c0e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const CONVERSATION_ID = 'b2c3d4e5-6f70-4812-9a3b-4c5d6e7f8091';
const SENDER_ID = '11111111-2222-4333-8444-555555555555';

describe('ReportConversationContextService: reports about the viewer (SEC-31)', () => {
  let service: ReportConversationContextService;
  let reports: { findOne: jest.Mock };
  let messages: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let audit: { writeAuditLog: jest.Mock };

  beforeEach(async () => {
    reports = {
      findOne: jest.fn().mockResolvedValue({
        id: REPORT_ID,
        subjectType: ReportSubjectType.Message,
        subjectId: MESSAGE_ID,
        evidence: null,
      }),
    };
    messages = {
      findOne: jest.fn().mockResolvedValue({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
      }),
      createQueryBuilder: jest.fn(),
    };
    audit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportConversationContextService,
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(Profile), useValue: {} },
        { provide: ModAuditService, useValue: audit },
        { provide: IdentitiesService, useValue: {} },
      ],
    }).compile();
    service = module.get(ReportConversationContextService);
  });

  it('refuses the sender with the coded refusal and reads nothing', async () => {
    const outcome = await service.getContext(REPORT_ID, SENDER_ID).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(ForbiddenException);
    if (outcome instanceof ForbiddenException) {
      expect(outcome.getResponse()).toMatchObject({
        code: REPORT_ABOUT_ACTOR_CODE,
      });
    }
    expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('refuses the sender named by the snapshot when the live row has no sender', async () => {
    messages.findOne.mockResolvedValue({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: null,
    });
    reports.findOne.mockResolvedValue({
      id: REPORT_ID,
      subjectType: ReportSubjectType.Message,
      subjectId: MESSAGE_ID,
      evidence: [
        {
          type: 'message-snapshot',
          messageId: MESSAGE_ID,
          body: 'reported words',
          senderId: SENDER_ID,
          createdAt: '2026-11-20T10:00:00.000Z',
          editedAt: null,
          deletedAtTimeOfReport: false,
        },
      ],
    });

    await expect(service.getContext(REPORT_ID, SENDER_ID)).rejects.toThrow(
      ForbiddenException,
    );
    expect(messages.createQueryBuilder).not.toHaveBeenCalled();
  });
});
