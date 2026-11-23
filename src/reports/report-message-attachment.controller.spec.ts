import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Response } from 'express';
import { Message } from '../messaging/entities/message.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { REPORT_ABOUT_ACTOR_CODE } from '../moderation/report-about-actor';
import { StorageService } from '../storage/storage.service';
import { Report, ReportSubjectType } from './entities/report.entity';
import { ReportMessageAttachmentController } from './report-message-attachment.controller';

/**
 * SEC-31: the staff member who sent a reported message is that report's
 * subject, so the file attached to it is refused to them and served to a
 * colleague as before.
 */

const REPORT_ID = '3d2f8a10-9c4b-4d6e-8f01-2a3b4c5d6e7f';
const MESSAGE_ID = '7f1c0e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const SENDER_ID = '11111111-2222-4333-8444-555555555555';
const ATTACHMENT_KEY = `message-images/${SENDER_ID}/66666666-7777-4888-8999-aaaaaaaaaaaa.jpg`;

interface Viewer {
  userId: string;
  email: string;
  status: string;
  role: string;
}

const COLLEAGUE: Viewer = {
  userId: '99999999-8888-4777-8666-555555555555',
  email: 'mod@example.com',
  status: 'active',
  role: 'moderator',
};

interface ResponseStub {
  setHeader: jest.Mock;
  redirect: jest.Mock;
}

describe('ReportMessageAttachmentController: reports about the viewer (SEC-31)', () => {
  let controller: ReportMessageAttachmentController;
  let reports: { findOne: jest.Mock };
  let messages: { findOne: jest.Mock };
  let auditLogs: { create: jest.Mock; save: jest.Mock };
  let storage: { headObject: jest.Mock; createPresignedDownload: jest.Mock };
  let response: ResponseStub;

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
        senderId: SENDER_ID,
        attachment: { kind: 'image', url: ATTACHMENT_KEY },
      }),
    };
    auditLogs = {
      create: jest.fn((values: object) => values),
      save: jest.fn((row: object) => Promise.resolve(row)),
    };
    storage = {
      headObject: jest
        .fn()
        .mockResolvedValue({ contentType: 'image/jpeg', contentLength: 1024 }),
      createPresignedDownload: jest
        .fn()
        .mockResolvedValue('https://bucket.example/signed'),
    };
    response = { setHeader: jest.fn(), redirect: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReportMessageAttachmentController],
      providers: [
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(ModAuditLog), useValue: auditLogs },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    controller = module.get(ReportMessageAttachmentController);
  });

  function serve(viewer: Viewer): Promise<void> {
    const expressResponse: Pick<Response, 'setHeader' | 'redirect'> = response;
    return controller.serve(REPORT_ID, viewer, expressResponse as Response);
  }

  it('refuses the sender with the coded report-about-you refusal and logs no view', async () => {
    const outcome = await serve({ ...COLLEAGUE, userId: SENDER_ID }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(ForbiddenException);
    if (outcome instanceof ForbiddenException) {
      expect(outcome.getResponse()).toMatchObject({
        code: REPORT_ABOUT_ACTOR_CODE,
      });
    }
    expect(auditLogs.save).not.toHaveBeenCalled();
    expect(storage.createPresignedDownload).not.toHaveBeenCalled();
  });

  it('refuses the sender named by the snapshot once the message row is gone', async () => {
    messages.findOne.mockResolvedValue(null);
    reports.findOne.mockResolvedValue({
      id: REPORT_ID,
      subjectType: ReportSubjectType.Message,
      subjectId: MESSAGE_ID,
      evidence: [
        {
          type: 'message-snapshot',
          messageId: MESSAGE_ID,
          body: '',
          senderId: SENDER_ID,
          createdAt: '2026-11-20T10:00:00.000Z',
          editedAt: null,
          deletedAtTimeOfReport: true,
          attachment: {
            storageKey: ATTACHMENT_KEY,
            fileName: null,
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
            provider: null,
            caption: null,
          },
        },
      ],
    });

    await expect(serve({ ...COLLEAGUE, userId: SENDER_ID })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('serves the file to a colleague and records the view', async () => {
    await serve(COLLEAGUE);

    expect(auditLogs.save).toHaveBeenCalledTimes(1);
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://bucket.example/signed',
    );
  });
});
