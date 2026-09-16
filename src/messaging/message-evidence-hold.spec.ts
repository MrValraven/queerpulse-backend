import { MessageKind, type Message } from './entities/message.entity';
import {
  isEvidenceHoldActive,
  messageAttachmentFacts,
  messageAttachmentStorageKeys,
  primaryMessageAttachmentStorageKey,
} from './message-evidence-hold';
import { toConversationContextMessage } from '../moderation/report-conversation-context-response';
import type { Profile } from '../users/entities/profile.entity';

const SENDER_ID = '11111111-1111-4111-8111-111111111111';
const IMAGE_KEY = `message-images/${SENDER_ID}/22222222-2222-4222-8222-222222222222.jpg`;
const DOCUMENT_KEY = `message-documents/${SENDER_ID}/33333333-3333-4333-8333-333333333333.pdf`;

describe('message evidence hold helpers (PRD-361)', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  it('treats only a future purge moment as an active hold', () => {
    expect(isEvidenceHoldActive(new Date('2026-09-16T00:00:00Z'), now)).toBe(
      true,
    );
    expect(isEvidenceHoldActive(now, now)).toBe(false);
    expect(isEvidenceHoldActive(new Date('2026-09-01T00:00:00Z'), now)).toBe(
      false,
    );
    expect(isEvidenceHoldActive(null, now)).toBe(false);
    expect(isEvidenceHoldActive(undefined, now)).toBe(false);
  });

  it('never treats an external GIF URL as a purgeable or servable key', () => {
    const gif = {
      url: 'https://static.klipy.com/some.gif',
      previewUrl: 'https://static.klipy.com/some-small.gif',
      width: 100,
      height: 100,
      provider: 'klipy',
    };
    expect(messageAttachmentStorageKeys(gif)).toEqual([]);
    expect(primaryMessageAttachmentStorageKey(gif)).toBeNull();
  });

  it('normalises a /files/ reference and deduplicates url and previewUrl', () => {
    const image = {
      url: `/files/${IMAGE_KEY}`,
      previewUrl: IMAGE_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    };
    expect(messageAttachmentStorageKeys(image)).toEqual([IMAGE_KEY]);
    expect(primaryMessageAttachmentStorageKey(image)).toBe(IMAGE_KEY);
  });

  it('reports document facts and never a URL', () => {
    const facts = messageAttachmentFacts({
      url: DOCUMENT_KEY,
      fileName: 'lease.pdf',
      byteSize: 2048,
      contentType: 'application/pdf',
      provider: 'upload',
    });
    expect(facts).toEqual({
      fileName: 'lease.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    });
  });
});

describe('toConversationContextMessage (PRD-360)', () => {
  const reportedMessageId = '44444444-4444-4444-8444-444444444444';

  function row(overrides: Partial<Message>): Message {
    return {
      id: '55555555-5555-4555-8555-555555555555',
      conversationId: '66666666-6666-4666-8666-666666666666',
      senderId: SENDER_ID,
      body: 'hello',
      kind: MessageKind.User,
      systemEvent: null,
      attachment: null,
      replyToId: null,
      clientMessageId: null,
      forwarded: false,
      createdAt: new Date('2026-09-15T10:00:00Z'),
      editedAt: null,
      deletedAt: null,
      attachmentPurgeAfter: null,
      ...overrides,
    } as Message;
  }

  it('blanks a tombstone that is not the reported message', () => {
    const dto = toConversationContextMessage(
      row({ deletedAt: new Date(), body: 'held body' }),
      new Map(),
      reportedMessageId,
      null,
    );
    expect(dto.body).toBeNull();
    expect(dto.attachment).toBeNull();
    expect(dto.isDeleted).toBe(true);
  });

  it('keeps the retained body on the reported tombstone', () => {
    const dto = toConversationContextMessage(
      row({ id: reportedMessageId, deletedAt: new Date(), body: 'held body' }),
      new Map(),
      reportedMessageId,
      null,
    );
    expect(dto.body).toBe('held body');
    expect(dto.isReportedMessage).toBe(true);
  });

  it('renders an erased sender as null, never a placeholder id', () => {
    const dto = toConversationContextMessage(
      row({ senderId: null }),
      new Map(),
      reportedMessageId,
      null,
    );
    expect(dto.senderId).toBeNull();
    expect(dto.senderDisplayName).toBeNull();
  });

  it('names a sender from the batched profile map', () => {
    const profiles = new Map([
      [
        SENDER_ID,
        { userId: SENDER_ID, firstName: 'Ana', lastName: 'L.', slug: 'ana' },
      ],
    ]) as unknown as Map<string, Profile>;
    const dto = toConversationContextMessage(
      row({}),
      profiles,
      reportedMessageId,
      null,
    );
    expect(dto.senderDisplayName).toBe('Ana L.');
    expect(dto.senderSlug).toBe('ana');
  });
});
