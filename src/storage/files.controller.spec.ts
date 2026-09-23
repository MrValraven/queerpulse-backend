import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Response } from 'express';
import { PassThrough, Readable } from 'stream';
import { Repository } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import { User } from '../users/entities/user.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Message } from '../messaging/entities/message.entity';
import {
  describeDirectThreadSeats,
  isCoveredByMailboxStaffFloor,
  isSeatExcludedFromMailbox,
  mailboxStaffHistoryFloorCoversPredicate,
  NO_MAILBOX_IDENTITY_BLOCKS,
  seatExcludedFromMailboxPredicate,
} from '../messaging/mailbox-seats';
import { FilesController } from './files.controller';
import { StorageService } from './storage.service';

const PRESIGNED_DOWNLOAD =
  'https://queerpulse-prod.storage.railway.app/key?X-Amz-Signature=abc';

const USER_SEGMENT = '11111111-2222-3333-4444-555555555555';
const FILE_SEGMENT = '66666666-7777-8888-9999-000000000000';

const AVATAR_KEY = `avatars/${USER_SEGMENT}/${FILE_SEGMENT}.jpg`;
const WORK_KEY = `work/${USER_SEGMENT}/${FILE_SEGMENT}.png`;
const STORY_COVER_KEY = `story-covers/${USER_SEGMENT}/${FILE_SEGMENT}.webp`;
const GATHERING_KEY = `gathering-photos/${USER_SEGMENT}/${FILE_SEGMENT}.jpg`;
const MESSAGE_IMAGE_KEY = `message-images/${USER_SEGMENT}/${FILE_SEGMENT}.jpg`;
const MESSAGE_DOCUMENT_KEY = `message-documents/${USER_SEGMENT}/${FILE_SEGMENT}.pdf`;

const LOGGED_IN = { userId: USER_SEGMENT, email: 'member@example.com' };
const EXPECTED_HISTORY_FLOOR_CLAUSE = `NOT ${mailboxStaffHistoryFloorCoversPredicate('message.created_at', 'participant')}`;
// A logged-in member who did NOT upload the gathering photo (their id differs
// from the `<ownerUserId>` segment embedded in GATHERING_KEY).
const OTHER_MEMBER = {
  userId: '99999999-8888-7777-6666-555555555555',
  email: 'other@example.com',
};

describe('FilesController', () => {
  let controller: FilesController;
  let storage: {
    createPresignedDownload: jest.Mock;
    validateImageMagicBytes: jest.Mock;
    openObjectStream: jest.Mock;
  };
  let users: { findOne: jest.Mock };
  let messageQueryBuilder: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getExists: jest.Mock;
  };
  let messages: { createQueryBuilder: jest.Mock };
  let response: { redirect: jest.Mock; setHeader: jest.Mock };

  beforeEach(() => {
    // The per-process validated-key memo is static, so isolate it between tests
    // (an earlier `'valid'` verdict would otherwise let a later test skip the
    // magic-byte check for the same key).
    (
      FilesController as unknown as { validatedKeys: Set<string> }
    ).validatedKeys.clear();
    storage = {
      createPresignedDownload: jest.fn().mockResolvedValue(PRESIGNED_DOWNLOAD),
      // Default: bytes match the declared image type, so serving proceeds.
      validateImageMagicBytes: jest.fn().mockResolvedValue('valid'),
      openObjectStream: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(Readable.from([Buffer.from('%PDF-1.7')])),
        ),
    };
    // Default: the key owner is not a withheld (suspended) member, so serving
    // proceeds. `null` stands in for "no matching owner row" — the gate only
    // withholds on a resolved Suspended owner.
    users = { findOne: jest.fn().mockResolvedValue(null) };
    // Default: the requester is NOT a participant of any conversation holding
    // the message-image key; individual tests flip `getExists` to true.
    messageQueryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getExists: jest.fn().mockResolvedValue(false),
    };
    messages = {
      createQueryBuilder: jest.fn().mockReturnValue(messageQueryBuilder),
    };
    response = { redirect: jest.fn(), setHeader: jest.fn() };
    controller = new FilesController(
      storage as unknown as StorageService,
      users as unknown as Repository<User>,
      messages as unknown as Repository<Message>,
    );
  });

  // Express 5 / path-to-regexp 8 hand `@Param('key')` back as an ARRAY of
  // decoded path segments for a named wildcard (`*key`), not a joined string —
  // see `files.controller.ts` for the empirical confirmation. Driving tests
  // through a hand-passed string would let every test pass green against a
  // route that 404s on every real request, so this helper reproduces the real
  // router shape.
  const serve = (key: string, user: unknown) =>
    controller.serve(
      key.split('/'),
      user as never,
      response as unknown as Response,
    );

  describe('public kinds', () => {
    it.each([
      ['avatars', AVATAR_KEY],
      ['work', WORK_KEY],
      ['story-covers', STORY_COVER_KEY],
    ])('redirects %s without a session', async (_label, key) => {
      await serve(key, null);
      expect(storage.createPresignedDownload).toHaveBeenCalledWith(key, {
        asAttachment: false,
      });
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('also redirects when a session is present', async () => {
      await serve(AVATAR_KEY, LOGGED_IN);
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });
  });

  describe('gathering photos', () => {
    it('redirects for the member who uploaded the photo', async () => {
      await serve(GATHERING_KEY, LOGGED_IN);
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('rejects an anonymous request', async () => {
      await expect(serve(GATHERING_KEY, null)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    it('404s for a logged-in member who is not the uploader (IDOR guard)', async () => {
      await expect(serve(GATHERING_KEY, OTHER_MEMBER)).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });
  });

  describe('message images (participant-gated, M7)', () => {
    it('rejects an anonymous request (no longer world-readable by URL)', async () => {
      await expect(serve(MESSAGE_IMAGE_KEY, null)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    it('redirects for a conversation participant', async () => {
      messageQueryBuilder.getExists.mockResolvedValue(true);
      await serve(MESSAGE_IMAGE_KEY, OTHER_MEMBER);
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('404s for a logged-in member who participates in no such conversation', async () => {
      messageQueryBuilder.getExists.mockResolvedValue(false);
      await expect(serve(MESSAGE_IMAGE_KEY, OTHER_MEMBER)).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    it('does not fall back to the uploader-only check (participant path, not owner path)', async () => {
      // The uploader (their id is the key's owner segment) is still refused when
      // they are not a participant — proof the branch is participant-scoped, not
      // uploader-scoped.
      messageQueryBuilder.getExists.mockResolvedValue(false);
      await expect(serve(MESSAGE_IMAGE_KEY, LOGGED_IN)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // Task 13f: the asymmetric block rule applies to attachment downloads the
  // same way it applies to every other read of a business mailbox thread. The
  // fake query builder cannot evaluate real SQL, so it cannot itself tell a
  // blocked staff seat from an unblocked one. What these tests confirm is
  // that the participant query now CARRIES the block-aware predicate at all,
  // which pre-task `isMessageAttachmentParticipant` never did.
  describe('message images (asymmetric block rule, Task 13f)', () => {
    it("composes blockedStaffSeatPredicate's EXISTS clause into the participant query", async () => {
      messageQueryBuilder.getExists.mockResolvedValue(true);
      await serve(MESSAGE_IMAGE_KEY, OTHER_MEMBER);
      const andWhereClauses = messageQueryBuilder.andWhere.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(
        andWhereClauses.some((clause) => clause.includes('blocked_staff_seat')),
      ).toBe(true);
    });

    it('negates the predicate, so a blocked staff seat is excluded from the grant', async () => {
      messageQueryBuilder.getExists.mockResolvedValue(true);
      await serve(MESSAGE_IMAGE_KEY, OTHER_MEMBER);
      const andWhereClauses = messageQueryBuilder.andWhere.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      const blockClause = andWhereClauses.find((clause) =>
        clause.includes('blocked_staff_seat'),
      );
      expect(blockClause).toMatch(/^NOT /);
    });
  });

  // Task 14a: a staff member who has left a business downloads nothing from
  // its mailbox threads. The participant query runs against a fixture: the
  // stand-in below understands only the clauses it was told about and throws
  // on any other, and it answers the exclusion clause through its in-memory
  // twin (`isSeatExcludedFromMailbox`), limited to direct threads as the
  // SQL is, so the fixture follows the shared rule.
  describe('message attachments of a business mailbox thread (departed staff, Task 14a)', () => {
    const MAILBOX_THREAD = 'mailbox-thread';
    const GROUP_THREAD = 'group-thread';
    const CUSTOMER = 'aaaaaaaa-0000-4000-8000-000000000001';
    const DEPARTED_STAFF = 'aaaaaaaa-0000-4000-8000-000000000002';
    const COLLEAGUE = 'aaaaaaaa-0000-4000-8000-000000000003';
    const GROUP_LEAVER = 'aaaaaaaa-0000-4000-8000-000000000004';
    const MAILBOX_IDENTITY = 'mailbox-identity';
    const GROUP_IMAGE_KEY = `message-images/${USER_SEGMENT}/bbbbbbbb-0000-4000-8000-000000000000.jpg`;
    const LEFT_AT = new Date('2026-09-20T12:00:00.000Z');
    const EXPECTED_EXCLUSION_CLAUSE = `NOT ${seatExcludedFromMailboxPredicate('message.conversation_id', ':userId')}`;

    const identityKindById = new Map<string, IdentityKind>([
      [MAILBOX_IDENTITY, IdentityKind.Listing],
      [`${CUSTOMER}-identity`, IdentityKind.Profile],
      [`${GROUP_LEAVER}-identity`, IdentityKind.Profile],
      [`${COLLEAGUE}-identity`, IdentityKind.Profile],
    ]);
    const groupThreadIds = new Set([GROUP_THREAD]);
    const attachments = [
      { conversationId: MAILBOX_THREAD, url: MESSAGE_IMAGE_KEY },
      { conversationId: GROUP_THREAD, url: GROUP_IMAGE_KEY },
    ];
    let seats: ConversationParticipant[];

    function fixtureSeat(
      conversationId: string,
      userId: string,
      identityId: string,
      leftAt: Date | null = null,
    ): ConversationParticipant {
      return {
        conversationId,
        userId,
        identityId,
        leftAt,
      } as unknown as ConversationParticipant;
    }

    function isExcluded(ownSeat: ConversationParticipant): boolean {
      if (groupThreadIds.has(ownSeat.conversationId)) {
        return false;
      }
      return isSeatExcludedFromMailbox(
        ownSeat,
        describeDirectThreadSeats(
          ownSeat.identityId,
          seats.filter(
            (seat) =>
              seat.conversationId === ownSeat.conversationId &&
              seat !== ownSeat,
          ),
          identityKindById,
        ),
        new Set<string>(),
        NO_MAILBOX_IDENTITY_BLOCKS,
      );
    }

    beforeEach(() => {
      seats = [
        fixtureSeat(MAILBOX_THREAD, CUSTOMER, `${CUSTOMER}-identity`),
        fixtureSeat(MAILBOX_THREAD, DEPARTED_STAFF, MAILBOX_IDENTITY, LEFT_AT),
        fixtureSeat(MAILBOX_THREAD, COLLEAGUE, MAILBOX_IDENTITY),
        fixtureSeat(
          GROUP_THREAD,
          GROUP_LEAVER,
          `${GROUP_LEAVER}-identity`,
          LEFT_AT,
        ),
        fixtureSeat(GROUP_THREAD, COLLEAGUE, `${COLLEAGUE}-identity`),
      ];
      const parameters: Record<string, unknown> = {};
      const clauses: string[] = [];
      const record = (clause: string, clauseParameters?: object) => {
        clauses.push(clause);
        Object.assign(parameters, clauseParameters);
        return messageQueryBuilder;
      };
      messageQueryBuilder.innerJoin.mockImplementation(
        (
          _table: string,
          _alias: string,
          _condition: string,
          joinParameters?: object,
        ) => {
          Object.assign(parameters, joinParameters);
          return messageQueryBuilder;
        },
      );
      messageQueryBuilder.where.mockImplementation(record);
      messageQueryBuilder.andWhere.mockImplementation(record);
      messageQueryBuilder.getExists.mockImplementation(() => {
        const userId = parameters.userId as string;
        const attachmentForms = parameters.attachmentForms as string[];
        let rows = attachments.flatMap((attachment) =>
          seats
            .filter(
              (seat) =>
                seat.conversationId === attachment.conversationId &&
                seat.userId === userId,
            )
            .map((seat) => ({ attachment, seat })),
        );
        for (const clause of clauses) {
          if (
            clause === "message.attachment ->> 'url' IN (:...attachmentForms)"
          ) {
            rows = rows.filter(({ attachment }) =>
              attachmentForms.includes(attachment.url),
            );
          } else if (
            clause === 'message.deletedAt IS NULL' ||
            clause === 'message.attachment IS NOT NULL'
          ) {
            continue;
          } else if (clause === EXPECTED_EXCLUSION_CLAUSE) {
            rows = rows.filter(({ seat }) => !isExcluded(seat));
          } else if (clause === EXPECTED_HISTORY_FLOOR_CLAUSE) {
            // Task 13h: no seat in this fixture holds a history floor.
            rows = rows.filter(({ seat }) => seat.clearedAt == null);
          } else {
            throw new Error(`Unrecognised participant clause: ${clause}`);
          }
        }
        return Promise.resolve(rows.length > 0);
      });
    });

    it('refuses the departed staff member', async () => {
      await expect(
        serve(MESSAGE_IMAGE_KEY, { userId: DEPARTED_STAFF }),
      ).rejects.toThrow(NotFoundException);
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    it('serves the live colleague and the customer', async () => {
      await serve(MESSAGE_IMAGE_KEY, { userId: COLLEAGUE });
      await serve(MESSAGE_IMAGE_KEY, { userId: CUSTOMER });

      expect(response.redirect).toHaveBeenCalledTimes(2);
    });

    it('still serves a member who left a group what was posted there (unchanged behaviour)', async () => {
      await serve(GROUP_IMAGE_KEY, { userId: GROUP_LEAVER });

      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('serves the staff member again once they are seated again', async () => {
      const departedSeat = seats.find(
        (seat) =>
          seat.conversationId === MAILBOX_THREAD &&
          seat.userId === DEPARTED_STAFF,
      )!;
      departedSeat.leftAt = null;

      await serve(MESSAGE_IMAGE_KEY, { userId: DEPARTED_STAFF });

      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('carries the shared exclusion rule, block and departure together, in the participant query', async () => {
      await serve(MESSAGE_IMAGE_KEY, { userId: COLLEAGUE });

      expect(
        messageQueryBuilder.andWhere.mock.calls.map(
          (call: unknown[]) => call[0] as string,
        ),
      ).toContain(EXPECTED_EXCLUSION_CLAUSE);
    });
  });

  // Task 13h: a mailbox staff seat's history floor (`cleared_at`) reaches
  // the bytes. A co-manager seated in a moved business thread holds a floor
  // at its first enquiry, so the owner's and the customer's earlier private
  // attachments are refused exactly as a non-participant is, and later ones
  // are served. Fix round 1: a "clear chat" on a seat that speaks for the
  // member themself keeps its downloads. The stand-in answers the floor
  // clause through its in-memory twin (`isCoveredByMailboxStaffFloor`) and
  // throws on any clause it does not know.
  describe('message attachments below a history floor (Task 13h)', () => {
    const MOVED_THREAD = 'moved-thread';
    const PERSONAL_THREAD = 'personal-thread';
    const LISTING_IDENTITY = 'listing-identity';
    const CUSTOMER_IDENTITY = 'customer-identity';
    const FRIEND_IDENTITY = 'friend-identity';
    const OWNER = 'cccccccc-0000-4000-8000-000000000001';
    const CUSTOMER = 'cccccccc-0000-4000-8000-000000000002';
    const CO_MANAGER = 'cccccccc-0000-4000-8000-000000000003';
    const FRIEND = 'cccccccc-0000-4000-8000-000000000004';
    const HISTORY_FLOOR = new Date('2026-09-10T12:00:00.000Z');
    const PRE_FLOOR_IMAGE_KEY = `message-images/${OWNER}/dddddddd-0000-4000-8000-000000000001.jpg`;
    const PRE_FLOOR_DOCUMENT_KEY = `message-documents/${CUSTOMER}/dddddddd-0000-4000-8000-000000000002.pdf`;
    const POST_FLOOR_IMAGE_KEY = `message-images/${CUSTOMER}/dddddddd-0000-4000-8000-000000000003.jpg`;
    const PERSONAL_CLEARED_IMAGE_KEY = `message-images/${CUSTOMER}/dddddddd-0000-4000-8000-000000000004.jpg`;
    const identityKindById = new Map<string, IdentityKind>([
      [LISTING_IDENTITY, IdentityKind.Listing],
      [CUSTOMER_IDENTITY, IdentityKind.Profile],
      [FRIEND_IDENTITY, IdentityKind.Profile],
    ]);
    const attachments = [
      {
        conversationId: MOVED_THREAD,
        url: PRE_FLOOR_IMAGE_KEY,
        createdAt: new Date('2026-09-10T11:00:00.000Z'),
      },
      {
        conversationId: MOVED_THREAD,
        url: PRE_FLOOR_DOCUMENT_KEY,
        createdAt: new Date('2026-09-10T11:30:00.000Z'),
      },
      {
        conversationId: MOVED_THREAD,
        url: POST_FLOOR_IMAGE_KEY,
        createdAt: new Date('2026-09-10T13:00:00.000Z'),
      },
      {
        conversationId: PERSONAL_THREAD,
        url: PERSONAL_CLEARED_IMAGE_KEY,
        createdAt: new Date('2026-09-10T11:00:00.000Z'),
      },
    ];
    let seats: Array<{
      conversationId: string;
      userId: string;
      identityId: string;
      clearedAt: Date | null;
    }>;

    beforeEach(() => {
      seats = [
        {
          conversationId: MOVED_THREAD,
          userId: OWNER,
          identityId: LISTING_IDENTITY,
          clearedAt: null,
        },
        {
          conversationId: MOVED_THREAD,
          userId: CUSTOMER,
          identityId: CUSTOMER_IDENTITY,
          clearedAt: null,
        },
        {
          conversationId: MOVED_THREAD,
          userId: CO_MANAGER,
          identityId: LISTING_IDENTITY,
          clearedAt: HISTORY_FLOOR,
        },
        // A personal thread whose friend cleared the chat at the same
        // instant: a seat that speaks for the member themself.
        {
          conversationId: PERSONAL_THREAD,
          userId: CUSTOMER,
          identityId: CUSTOMER_IDENTITY,
          clearedAt: null,
        },
        {
          conversationId: PERSONAL_THREAD,
          userId: FRIEND,
          identityId: FRIEND_IDENTITY,
          clearedAt: HISTORY_FLOOR,
        },
      ];
      const parameters: Record<string, unknown> = {};
      const clauses: string[] = [];
      const record = (clause: string, clauseParameters?: object) => {
        clauses.push(clause);
        Object.assign(parameters, clauseParameters);
        return messageQueryBuilder;
      };
      messageQueryBuilder.innerJoin.mockImplementation(
        (
          _table: string,
          _alias: string,
          _condition: string,
          joinParameters?: object,
        ) => {
          Object.assign(parameters, joinParameters);
          return messageQueryBuilder;
        },
      );
      messageQueryBuilder.where.mockImplementation(record);
      messageQueryBuilder.andWhere.mockImplementation(record);
      messageQueryBuilder.getExists.mockImplementation(() => {
        const userId = parameters.userId as string;
        const attachmentForms = parameters.attachmentForms as string[];
        let rows = attachments.flatMap((attachment) =>
          seats
            .filter(
              (seat) =>
                seat.conversationId === attachment.conversationId &&
                seat.userId === userId,
            )
            .map((seat) => ({ attachment, seat })),
        );
        for (const clause of clauses) {
          if (
            clause === "message.attachment ->> 'url' IN (:...attachmentForms)"
          ) {
            rows = rows.filter(({ attachment }) =>
              attachmentForms.includes(attachment.url),
            );
          } else if (
            clause === 'message.deletedAt IS NULL' ||
            clause === 'message.attachment IS NOT NULL' ||
            // No block or departure in this fixture.
            clause ===
              `NOT ${seatExcludedFromMailboxPredicate('message.conversation_id', ':userId')}`
          ) {
            continue;
          } else if (clause === EXPECTED_HISTORY_FLOOR_CLAUSE) {
            rows = rows.filter(
              ({ attachment, seat }) =>
                !isCoveredByMailboxStaffFloor(attachment.createdAt, {
                  clearedAt: seat.clearedAt,
                  identityKind: identityKindById.get(seat.identityId),
                  isGroupConversation: false,
                  isOfficialConversation: false,
                }),
            );
          } else {
            throw new Error(`Unrecognised participant clause: ${clause}`);
          }
        }
        return Promise.resolve(rows.length > 0);
      });
    });

    it("refuses a co-manager the owner's photo from before their floor, as a non-participant is refused", async () => {
      await expect(
        serve(PRE_FLOOR_IMAGE_KEY, { userId: CO_MANAGER }),
      ).rejects.toThrow(NotFoundException);
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    it("refuses a co-manager the customer's document from before their floor", async () => {
      await expect(
        serve(PRE_FLOOR_DOCUMENT_KEY, { userId: CO_MANAGER }),
      ).rejects.toThrow(NotFoundException);
      expect(storage.openObjectStream).not.toHaveBeenCalled();
    });

    it('serves the co-manager a photo from after their floor', async () => {
      await serve(POST_FLOOR_IMAGE_KEY, { userId: CO_MANAGER });

      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('serves the pre-floor photo to the customer, who holds no floor', async () => {
      await serve(PRE_FLOOR_IMAGE_KEY, { userId: CUSTOMER });

      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('still serves the customer the pre-floor photo after the customer cleared the mailbox thread', async () => {
      seats.find(
        (seat) =>
          seat.conversationId === MOVED_THREAD && seat.userId === CUSTOMER,
      )!.clearedAt = HISTORY_FLOOR;

      await serve(PRE_FLOOR_IMAGE_KEY, { userId: CUSTOMER });

      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('still serves a personal-thread member the photo they cleared, as before this task', async () => {
      await serve(PERSONAL_CLEARED_IMAGE_KEY, { userId: FRIEND });

      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('carries the staff-scoped floor as an inclusive comparison in SQL on the requester seat', async () => {
      await serve(POST_FLOOR_IMAGE_KEY, { userId: CO_MANAGER });

      const clauses = messageQueryBuilder.andWhere.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(clauses).toContain(EXPECTED_HISTORY_FLOOR_CLAUSE);
      expect(EXPECTED_HISTORY_FLOOR_CLAUSE).toContain(
        'message.created_at <= participant.cleared_at',
      );
      expect(EXPECTED_HISTORY_FLOOR_CLAUSE).toContain(
        `"floor_staff_identity"."kind" <> 'profile'`,
      );
    });
  });

  // PRD-226: a document attachment gets the IDENTICAL participant-scoped
  // treatment as a message image (M7) — never a weaker one, since a document
  // is more sensitive than a photo, not less. Same fixture shape as the
  // "message images" suite above, just against the `message-document` kind.
  describe('message documents (participant-gated, PRD-226)', () => {
    it('rejects an anonymous request', async () => {
      await expect(serve(MESSAGE_DOCUMENT_KEY, null)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    // PRD-369: a document is streamed through the backend with download-only
    // headers and never redirected to a presigned URL.
    it('streams to a conversation participant as a sandboxed attachment', async () => {
      messageQueryBuilder.getExists.mockResolvedValue(true);
      const sink = Object.assign(new PassThrough(), {
        req: { method: 'GET' },
        setHeader: jest.fn(),
        status: jest.fn(),
      });
      sink.status.mockReturnValue(sink);
      sink.resume();
      await controller.serve(
        MESSAGE_DOCUMENT_KEY.split('/'),
        OTHER_MEMBER as never,
        sink as unknown as Response,
      );
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
      expect(storage.openObjectStream).toHaveBeenCalledWith(
        MESSAGE_DOCUMENT_KEY,
      );
      expect(sink.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringMatching(/^attachment; /),
      );
      expect(sink.setHeader).toHaveBeenCalledWith(
        'Content-Security-Policy',
        "sandbox; default-src 'none'",
      );
      expect(sink.setHeader).toHaveBeenCalledWith(
        'X-Content-Type-Options',
        'nosniff',
      );
    });

    it('404s for a logged-in member who participates in no such conversation', async () => {
      messageQueryBuilder.getExists.mockResolvedValue(false);
      await expect(serve(MESSAGE_DOCUMENT_KEY, OTHER_MEMBER)).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    it('does not fall back to the uploader-only check (participant path, not owner path)', async () => {
      messageQueryBuilder.getExists.mockResolvedValue(false);
      await expect(serve(MESSAGE_DOCUMENT_KEY, LOGGED_IN)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('content-type validation (magic bytes, M2)', () => {
    it('404s when the stored bytes do not match the declared image type', async () => {
      storage.validateImageMagicBytes.mockResolvedValue('mismatch');
      await expect(serve(AVATAR_KEY, null)).rejects.toThrow(NotFoundException);
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    it('serves (fail-open) when validation is indeterminate (transient read error)', async () => {
      storage.validateImageMagicBytes.mockResolvedValue('indeterminate');
      await serve(AVATAR_KEY, null);
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('memoises a passing key so it is only validated once per process', async () => {
      await serve(AVATAR_KEY, null);
      await serve(AVATAR_KEY, null);
      expect(storage.validateImageMagicBytes).toHaveBeenCalledTimes(1);
    });

    it('sets X-Content-Type-Options: nosniff on the redirect (L12)', async () => {
      await serve(AVATAR_KEY, null);
      expect(response.setHeader).toHaveBeenCalledWith(
        'X-Content-Type-Options',
        'nosniff',
      );
    });
  });

  describe('invalid keys', () => {
    it.each([
      ['an unknown prefix', `secrets/${USER_SEGMENT}/${FILE_SEGMENT}.jpg`],
      ['a traversal attempt', 'avatars/../../etc/passwd'],
      ['a disallowed extension', `avatars/${USER_SEGMENT}/${FILE_SEGMENT}.svg`],
      ['an empty key', ''],
    ])('404s on %s even with a session', async (_label, key) => {
      await expect(serve(key, LOGGED_IN)).rejects.toThrow(NotFoundException);
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    });

    it('404s rather than 401s on a bad key, so the route never reveals which keys exist', async () => {
      await expect(serve('secrets/a/b.jpg', null)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('router param shape', () => {
    it('joins an array param — the real Express 5 / path-to-regexp 8 shape — and resolves', async () => {
      await controller.serve(
        AVATAR_KEY.split('/'),
        null,
        response as unknown as Response,
      );
      expect(storage.createPresignedDownload).toHaveBeenCalledWith(AVATAR_KEY, {
        asAttachment: false,
      });
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('still resolves when handed a single string param (defensive)', async () => {
      await controller.serve(AVATAR_KEY, null, response as unknown as Response);
      expect(storage.createPresignedDownload).toHaveBeenCalledWith(AVATAR_KEY, {
        asAttachment: false,
      });
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('signs an attachment disposition when ?download=1 is passed', async () => {
      await controller.serve(
        AVATAR_KEY,
        null,
        response as unknown as Response,
        '1',
      );
      expect(storage.createPresignedDownload).toHaveBeenCalledWith(AVATAR_KEY, {
        asAttachment: true,
      });
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });
  });

  describe('caching', () => {
    it('allows private browser caching for public kinds, matching the presign TTL', async () => {
      await serve(AVATAR_KEY, null);
      expect(response.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, max-age=240',
      );
    });

    it('forbids all caching for session-gated kinds', async () => {
      await serve(GATHERING_KEY, LOGGED_IN);
      expect(response.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store',
      );
    });
  });
});
