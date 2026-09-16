import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { StorageService } from '../storage/storage.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * ENG-268: `MessagesService.purgeReleasedAttachmentBytes` (called only by
 * `MessageEvidenceHoldSweepService`, after it has already blanked the row,
 * PRD-361) had no spec of its own. It is the step that actually deletes
 * bytes from storage, so the valuable coverage proves the "still needed
 * elsewhere" guard (`isKeyStillNeededByAnotherMessage`) genuinely keeps an
 * object alive when it should, beyond a bare assertion that a delete call
 * happened at all.
 *
 * Scoped like `message-search-scoping.spec.ts`: only `Message` (for the
 * "still needed" query builder) and `StorageService` (for the delete call)
 * are real stand-ins; everything else `MessagesService` depends on but this
 * method never touches is a bare `{}`.
 */
describe('MessagesService.purgeReleasedAttachmentBytes (ENG-268 / PRD-361)', () => {
  interface StillNeededQueryBuilder {
    withDeleted: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getExists: jest.Mock;
  }

  function makeQueryBuilder(): StillNeededQueryBuilder {
    const qb = {} as StillNeededQueryBuilder;
    const self = (): StillNeededQueryBuilder => qb;
    qb.withDeleted = jest.fn(self);
    qb.where = jest.fn(self);
    qb.andWhere = jest.fn(self);
    qb.getExists = jest.fn();
    return qb;
  }

  // Owner and file segments must both be UUID-shaped: `parseStorageKey`
  // (src/storage/storage-key.ts) rejects anything else, which would make
  // `messageAttachmentStorageKeys` silently filter these out before the code
  // under test ever saw them. Mirrors `message-evidence-hold.spec.ts`'s own
  // fixture keys.
  const UPLOADER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const RELEASED_MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
  const IMAGE_KEY = `message-images/${UPLOADER_ID}/22222222-2222-4222-8222-222222222222.jpg`;
  const OTHER_IMAGE_KEY = `message-images/${UPLOADER_ID}/33333333-3333-4333-8333-333333333333.jpg`;
  const DOCUMENT_KEY = `message-documents/${UPLOADER_ID}/44444444-4444-4444-8444-444444444444.pdf`;

  let service: MessagesService;
  let qb: StillNeededQueryBuilder;
  let messages: { createQueryBuilder: jest.Mock };
  let storage: { deleteObjectByReference: jest.Mock };

  beforeEach(async () => {
    qb = makeQueryBuilder();
    messages = { createQueryBuilder: jest.fn(() => qb) };
    storage = { deleteObjectByReference: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: getRepositoryToken(Conversation), useValue: {} },
        { provide: getRepositoryToken(ConversationParticipant), useValue: {} },
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(Profile), useValue: {} },
        { provide: MessagingCoreService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConnectionsService, useValue: {} },
        { provide: BlockFilterService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: MentionNotificationService, useValue: {} },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = module.get(MessagesService);
  });

  it('does nothing at all for a released row with no attachment', async () => {
    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, null);

    expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
  });

  it('deletes the object when no other message still needs it', async () => {
    qb.getExists.mockResolvedValueOnce(false);

    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
      url: IMAGE_KEY,
      previewUrl: IMAGE_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    });

    expect(qb.where).toHaveBeenCalledWith(
      "message.attachment ->> 'url' IN (:...attachmentForms)",
      { attachmentForms: [IMAGE_KEY, `/files/${IMAGE_KEY}`] },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('message.id != :messageId', {
      messageId: RELEASED_MESSAGE_ID,
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(message.deletedAt IS NULL OR message.attachmentPurgeAfter IS NOT NULL)',
    );
    expect(storage.deleteObjectByReference).toHaveBeenCalledWith(IMAGE_KEY);
  });

  it('never deletes the object when a LIVE message still references it', async () => {
    // `getExists` TRUE models a still-live message (or a still-held tombstone
    // of the same forwarded object, PRD-361) that the "still needed" query
    // would find via `(deletedAt IS NULL OR attachmentPurgeAfter IS NOT NULL)`.
    qb.getExists.mockResolvedValueOnce(true);

    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
      url: IMAGE_KEY,
      previewUrl: IMAGE_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    });

    expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
  });

  it('checks its own attachment forms only against OTHER messages, excluding itself', async () => {
    qb.getExists.mockResolvedValueOnce(false);

    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
      url: IMAGE_KEY,
      previewUrl: IMAGE_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    });

    // The row THIS call is purging bytes for must never disqualify its own
    // key from deletion: `message.id != :messageId` is what keeps a
    // just-released row from perpetually "still needing" its own attachment.
    expect(qb.andWhere).toHaveBeenCalledWith('message.id != :messageId', {
      messageId: RELEASED_MESSAGE_ID,
    });
  });

  it('checks a document attachment by its url alone, with no previewUrl form', async () => {
    qb.getExists.mockResolvedValueOnce(false);

    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
      url: DOCUMENT_KEY,
      fileName: 'lease.pdf',
      byteSize: 2048,
      contentType: 'application/pdf',
      provider: 'upload',
    });

    expect(qb.where).toHaveBeenCalledWith(
      "message.attachment ->> 'url' IN (:...attachmentForms)",
      { attachmentForms: [DOCUMENT_KEY, `/files/${DOCUMENT_KEY}`] },
    );
    expect(storage.deleteObjectByReference).toHaveBeenCalledWith(DOCUMENT_KEY);
  });

  it('never checks or deletes an external GIF provider URL', async () => {
    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
      url: 'https://static.klipy.com/some.gif',
      previewUrl: 'https://static.klipy.com/some-small.gif',
      width: 100,
      height: 100,
      provider: 'klipy',
    });

    expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
  });

  it('checks two genuinely distinct keys on one attachment independently, keeping only the one still needed', async () => {
    // Every uploader sets `previewUrl` equal to `url` today (see
    // `GifAttachment`'s own doc comment), so this url != previewUrl shape is
    // synthetic. `messageAttachmentStorageKeys` still never assumes they
    // match, so the purge loop must check (and decide) each key on its own
    // merits rather than treating the whole attachment as one unit.
    qb.getExists
      .mockResolvedValueOnce(false) // IMAGE_KEY: nobody else needs it
      .mockResolvedValueOnce(true); // OTHER_IMAGE_KEY: still needed elsewhere

    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
      url: IMAGE_KEY,
      previewUrl: OTHER_IMAGE_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    });

    expect(messages.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(storage.deleteObjectByReference).toHaveBeenCalledTimes(1);
    expect(storage.deleteObjectByReference).toHaveBeenCalledWith(IMAGE_KEY);
    expect(storage.deleteObjectByReference).not.toHaveBeenCalledWith(
      OTHER_IMAGE_KEY,
    );
  });

  it('deduplicates one attachment whose url and previewUrl are the same key into a single check', async () => {
    qb.getExists.mockResolvedValueOnce(false);

    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
      url: IMAGE_KEY,
      previewUrl: IMAGE_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    });

    expect(messages.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(storage.deleteObjectByReference).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows a storage failure rather than throwing (best-effort by design)', async () => {
    qb.getExists.mockResolvedValueOnce(false);
    storage.deleteObjectByReference.mockRejectedValueOnce(
      new Error('bucket unreachable'),
    );

    await expect(
      service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
        url: IMAGE_KEY,
        previewUrl: IMAGE_KEY,
        width: 10,
        height: 10,
        provider: 'upload',
      }),
    ).resolves.toBeUndefined();
  });

  it('still attempts every other key after one key fails, rather than aborting the whole purge', async () => {
    qb.getExists.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    storage.deleteObjectByReference
      .mockRejectedValueOnce(new Error('bucket unreachable'))
      .mockResolvedValueOnce(true);

    await service.purgeReleasedAttachmentBytes(RELEASED_MESSAGE_ID, {
      url: IMAGE_KEY,
      previewUrl: OTHER_IMAGE_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    });

    expect(storage.deleteObjectByReference).toHaveBeenCalledTimes(2);
    expect(storage.deleteObjectByReference).toHaveBeenCalledWith(IMAGE_KEY);
    expect(storage.deleteObjectByReference).toHaveBeenCalledWith(
      OTHER_IMAGE_KEY,
    );
  });
});
