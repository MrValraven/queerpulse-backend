import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { Response } from 'express';
import { PassThrough, Readable } from 'stream';
import { Repository } from 'typeorm';
import {
  messageAttachmentReferenceFromImageUrl,
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import { IdentityKind } from '../identities/entities/identity.entity';
import { Message, MessageKind } from '../messaging/entities/message.entity';
import {
  mailboxStaffHistoryFloorCoversPredicate,
  seatExcludedFromMailboxPredicate,
} from '../messaging/mailbox-seats';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from '../messaging/message-visibility-predicates';
import { User } from '../users/entities/user.entity';
import { FilesController } from './files.controller';
import {
  messageAttachmentReference,
  parseMessageAttachmentReference,
} from './message-attachment-reference';
import {
  messageAttachmentRouteStorageKey,
  withMessageAttachmentRoute,
} from './message-attachment-route';
import { StorageService } from './storage.service';

/**
 * Final fix F1 (C1): the opaque message attachment route. The reference
 * itself, which messages render by it, and `FilesController` serving it.
 * The route's SQL is exercised on real Postgres by
 * `message-attachment-route.postgres.spec.ts`.
 */

const API_BASE_URL = 'https://api.example';
const MESSAGE_ID = '50000000-0000-4000-8000-000000000001';
const STAFF_ID = '10000000-0000-4000-8000-000000000001';
const VIEWER_ID = '10000000-0000-4000-8000-000000000011';
const FILE_SEGMENT = '66666666-7777-4888-9999-000000000000';
const IMAGE_KEY = `message-images/${STAFF_ID}/${FILE_SEGMENT}.jpg`;
const DOCUMENT_KEY = `message-documents/${STAFF_ID}/${FILE_SEGMENT}.pdf`;
const LISTING_IDENTITY_ID = 'identity-listing';
const PROFILE_IDENTITY_ID = 'identity-profile';
const IDENTITY_KINDS = new Map([
  [LISTING_IDENTITY_ID, IdentityKind.Listing],
  [PROFILE_IDENTITY_ID, IdentityKind.Profile],
]);

const imageAttachment = {
  url: IMAGE_KEY,
  previewUrl: IMAGE_KEY,
  width: 800,
  height: 600,
  provider: 'upload',
};
const documentAttachment = {
  url: DOCUMENT_KEY,
  fileName: 'menu.pdf',
  byteSize: 1024,
  contentType: 'application/pdf',
  provider: 'upload',
};

describe('the message attachment reference', () => {
  beforeAll(() => setImageUrlBase(API_BASE_URL));
  afterAll(() => resetImageUrlBaseForTesting());

  it('names the message and its attachment index, and parses back', () => {
    const reference = messageAttachmentReference(MESSAGE_ID);

    expect(reference).toBe(`messages/${MESSAGE_ID}/0`);
    expect(parseMessageAttachmentReference(reference)).toEqual({
      messageId: MESSAGE_ID,
      attachmentIndex: 0,
    });
  });

  it.each([
    `messages/${MESSAGE_ID}/1`,
    `messages/${MESSAGE_ID}/../0`,
    `messages/not-a-uuid/0`,
    IMAGE_KEY,
    `messages/${MESSAGE_ID}`,
  ])('refuses %s', (value) => {
    expect(parseMessageAttachmentReference(value)).toBeNull();
  });

  it('resolves to the files route through toImageUrl', () => {
    expect(toImageUrl(messageAttachmentReference(MESSAGE_ID))).toBe(
      `${API_BASE_URL}/files/messages/${MESSAGE_ID}/0`,
    );
  });

  it('collapses its own resolved URL back to the reference on a write, and returns null for any other value', () => {
    expect(
      messageAttachmentReferenceFromImageUrl(
        `${API_BASE_URL}/files/messages/${MESSAGE_ID}/0`,
      ),
    ).toBe(`messages/${MESSAGE_ID}/0`);
    expect(
      messageAttachmentReferenceFromImageUrl(
        `${API_BASE_URL}/files/${IMAGE_KEY}`,
      ),
    ).toBeNull();
    expect(
      messageAttachmentReferenceFromImageUrl(
        `https://elsewhere.example/files/messages/${MESSAGE_ID}/0`,
      ),
    ).toBeNull();
  });
});

describe('withMessageAttachmentRoute', () => {
  const row = (overrides: Partial<Message>) =>
    ({
      id: MESSAGE_ID,
      kind: MessageKind.Image,
      senderIdentityId: LISTING_IDENTITY_ID,
      attachment: imageAttachment,
      ...overrides,
    }) as Message;

  it('renders an image sent as a business by reference, preview included, without touching the row', () => {
    const message = row({});

    const rendered = withMessageAttachmentRoute(message, IDENTITY_KINDS);

    expect(rendered.attachment).toEqual({
      ...imageAttachment,
      url: `messages/${MESSAGE_ID}/0`,
      previewUrl: `messages/${MESSAGE_ID}/0`,
    });
    expect(message.attachment).toBe(imageAttachment);
  });

  it('renders a document sent as a business by reference, keeping its name', () => {
    const rendered = withMessageAttachmentRoute(
      row({ kind: MessageKind.Document, attachment: documentAttachment }),
      IDENTITY_KINDS,
    );

    expect(rendered.attachment).toEqual({
      ...documentAttachment,
      url: `messages/${MESSAGE_ID}/0`,
    });
  });

  it('leaves a personal message, a gif and a sticker as they are', () => {
    const personal = row({ senderIdentityId: PROFILE_IDENTITY_ID });
    const gif = row({ kind: MessageKind.Gif });
    const sticker = row({ kind: MessageKind.Sticker });

    expect(withMessageAttachmentRoute(personal, IDENTITY_KINDS)).toBe(personal);
    expect(withMessageAttachmentRoute(gif, IDENTITY_KINDS)).toBe(gif);
    expect(withMessageAttachmentRoute(sticker, IDENTITY_KINDS)).toBe(sticker);
  });

  it('serves the stored key of the claimed kind only', () => {
    expect(
      messageAttachmentRouteStorageKey({
        kind: MessageKind.Image,
        attachment: imageAttachment,
      }),
    ).toBe(IMAGE_KEY);
    expect(
      messageAttachmentRouteStorageKey({
        kind: MessageKind.Document,
        attachment: imageAttachment,
      }),
    ).toBeNull();
    expect(
      messageAttachmentRouteStorageKey({
        kind: MessageKind.Image,
        attachment: { ...imageAttachment, url: `/files/${IMAGE_KEY}` },
      }),
    ).toBe(IMAGE_KEY);
  });
});

describe('FilesController: GET /files/messages/:messageId/0', () => {
  let storage: {
    createPresignedDownload: jest.Mock;
    validateImageMagicBytes: jest.Mock;
    openObjectStream: jest.Mock;
    headObject: jest.Mock;
  };
  let users: { findOne: jest.Mock };
  let messageQuery: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getOne: jest.Mock;
    select: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getRawOne: jest.Mock;
  };
  let controller: FilesController;

  beforeEach(() => {
    (
      FilesController as unknown as { validatedKeys: Set<string> }
    ).validatedKeys.clear();
    storage = {
      createPresignedDownload: jest.fn(),
      validateImageMagicBytes: jest.fn().mockResolvedValue('valid'),
      openObjectStream: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(Readable.from([Buffer.from('image-bytes')])),
        ),
      headObject: jest.fn().mockResolvedValue({ contentLength: 11 }),
    };
    users = { findOne: jest.fn() };
    messageQuery = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      // The document download's display-name lookup.
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ fileName: 'menu.pdf' }),
    };
    controller = new FilesController(
      storage as unknown as StorageService,
      users as unknown as Repository<User>,
      {
        createQueryBuilder: jest.fn().mockReturnValue(messageQuery),
      } as unknown as Repository<Message>,
    );
  });

  function streamingResponse(method = 'GET') {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const headers: Record<string, string> = {};
    // `pipeline` detaches listeners from `response.req`, so the stand-in
    // request is an emitter.
    const response = Object.assign(sink, {
      req: Object.assign(new EventEmitter(), { method }),
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      status: jest.fn(),
      redirect: jest.fn(),
    });
    response.status.mockReturnValue(response);
    // A HEAD answer ends without a body; a GET's end comes from `pipeline`.
    if (method === 'HEAD') {
      Object.assign(response, { end: jest.fn() });
    }
    return { response, headers, body: () => Buffer.concat(chunks) };
  }

  const serveReference = (
    user: unknown,
    response: unknown,
    download?: string,
  ) =>
    controller.serve(
      `messages/${MESSAGE_ID}/0`.split('/'),
      user as never,
      response as Response,
      download,
    );

  it('refuses an anonymous request with 401', async () => {
    const { response } = streamingResponse();

    await expect(serveReference(null, response)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(messageQuery.getOne).not.toHaveBeenCalled();
  });

  it('refuses with 404 when the requester may not see the message, and reads no bytes', async () => {
    const { response } = streamingResponse();

    await expect(
      serveReference({ userId: VIEWER_ID }, response),
    ).rejects.toThrow(NotFoundException);
    expect(storage.validateImageMagicBytes).not.toHaveBeenCalled();
    expect(storage.openObjectStream).not.toHaveBeenCalled();
  });

  it('asks for that one message under the seat rules and the staff history floor', async () => {
    const { response } = streamingResponse();

    await serveReference({ userId: VIEWER_ID }, response).catch(() => null);

    expect(messageQuery.where).toHaveBeenCalledWith('message.id = :messageId', {
      messageId: MESSAGE_ID,
    });
    const clauses = messageQuery.andWhere.mock.calls.map(
      ([clause]: [string]) => clause,
    );
    expect(clauses).toContain(
      `NOT ${seatExcludedFromMailboxPredicate('message.conversation_id', ':userId')}`,
    );
    expect(clauses).toContain(
      `NOT ${mailboxStaffHistoryFloorCoversPredicate('message.created_at', 'participant')}`,
    );
    // Fix round N1: a taken-down message and a personal message are refused.
    expect(messageQuery.andWhere).toHaveBeenCalledWith(
      notModeratedMessagePredicate('message'),
      { messageSubjectType: MESSAGE_SUBJECT_TYPE },
    );
    expect(clauses).toContain('message.sender_identity_id IS NOT NULL');
    expect(
      clauses.some(
        (clause) =>
          clause.includes('"attachment_sender_identity"') &&
          clause.includes(`"kind" = 'profile'`) &&
          clause.trim().startsWith('NOT EXISTS'),
      ),
    ).toBe(true);
    expect(messageQuery.innerJoin).toHaveBeenCalledWith(
      'conversation_participants',
      'participant',
      expect.stringContaining('participant.user_id = :userId'),
      { userId: VIEWER_ID },
    );
  });

  it('streams an image it may see, with no redirect, and no header naming the uploader', async () => {
    messageQuery.getOne.mockResolvedValue({
      id: MESSAGE_ID,
      kind: MessageKind.Image,
      attachment: imageAttachment,
    });
    const { response, headers, body } = streamingResponse();

    await serveReference({ userId: VIEWER_ID }, response);

    expect(body().toString()).toBe('image-bytes');
    expect(response.redirect).not.toHaveBeenCalled();
    expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    expect(headers['Content-Type']).toBe('image/jpeg');
    expect(headers['Content-Disposition']).toBe(
      `inline; filename="${FILE_SEGMENT}.jpg"`,
    );
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(JSON.stringify(headers)).not.toContain(STAFF_ID);
    // The uploader's account status is not consulted, see the route's doc.
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('signs an attachment disposition for the Save button', async () => {
    messageQuery.getOne.mockResolvedValue({
      id: MESSAGE_ID,
      kind: MessageKind.Image,
      attachment: imageAttachment,
    });
    const { response, headers } = streamingResponse();

    await serveReference({ userId: VIEWER_ID }, response, '1');

    expect(headers['Content-Disposition']).toBe(
      `attachment; filename="${FILE_SEGMENT}.jpg"`,
    );
  });

  it('answers HEAD from the object metadata without opening the body', async () => {
    messageQuery.getOne.mockResolvedValue({
      id: MESSAGE_ID,
      kind: MessageKind.Image,
      attachment: imageAttachment,
    });
    const { response, headers } = streamingResponse('HEAD');

    await serveReference({ userId: VIEWER_ID }, response);

    expect(storage.openObjectStream).not.toHaveBeenCalled();
    expect(headers['Content-Length']).toBe('11');
    expect((response as unknown as { end: jest.Mock }).end).toHaveBeenCalled();
  });

  it('streams a document as the sandboxed download every document gets', async () => {
    messageQuery.getOne.mockResolvedValue({
      id: MESSAGE_ID,
      kind: MessageKind.Document,
      attachment: documentAttachment,
    });
    storage.openObjectStream.mockImplementation(() =>
      Promise.resolve(Readable.from([Buffer.from('%PDF-1.7')])),
    );
    const { response, headers, body } = streamingResponse();

    await serveReference({ userId: VIEWER_ID }, response);

    expect(body().toString()).toBe('%PDF-1.7');
    expect(headers['Content-Disposition']).toMatch(/^attachment;/);
    expect(JSON.stringify(headers)).not.toContain(STAFF_ID);
  });

  it('refuses a message whose stored key is not of its own kind', async () => {
    messageQuery.getOne.mockResolvedValue({
      id: MESSAGE_ID,
      kind: MessageKind.Image,
      attachment: { ...imageAttachment, url: DOCUMENT_KEY },
    });
    const { response } = streamingResponse();

    await expect(
      serveReference({ userId: VIEWER_ID }, response),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses bytes that fail the magic-byte check', async () => {
    messageQuery.getOne.mockResolvedValue({
      id: MESSAGE_ID,
      kind: MessageKind.Image,
      attachment: imageAttachment,
    });
    storage.validateImageMagicBytes.mockResolvedValue('mismatch');
    const { response } = streamingResponse();

    await expect(
      serveReference({ userId: VIEWER_ID }, response),
    ).rejects.toThrow(NotFoundException);
    expect(storage.openObjectStream).not.toHaveBeenCalled();
  });
});
