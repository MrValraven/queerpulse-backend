import { MessageKind } from './entities/message.entity';
import {
  RAW_ATTACHMENT_FALLBACK_KEYS,
  readableMessageBody,
  readableMessageEditedAt,
} from './legacy-message-body';

/**
 * Read-time guards for the two legacy chat row classes the product owner
 * chose to leave in the database: an attachment body holding a raw catalog
 * key, and a sticker edited before stickers became uneditable (ENG-405).
 */
describe('RAW_ATTACHMENT_FALLBACK_KEYS', () => {
  it('lists the image and document catalog keys', () => {
    expect([...RAW_ATTACHMENT_FALLBACK_KEYS]).toEqual([
      'messages:attachments.fallbackText',
      'messages:attachments.documentFallbackText',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RAW_ATTACHMENT_FALLBACK_KEYS)).toBe(true);
  });
});

describe('readableMessageBody', () => {
  it('reads a raw-key document body as File', () => {
    expect(
      readableMessageBody(
        MessageKind.Document,
        'messages:attachments.documentFallbackText',
      ),
    ).toBe('File');
  });

  it('reads a raw-key photo body as Photo', () => {
    expect(
      readableMessageBody(
        MessageKind.Image,
        'messages:attachments.fallbackText',
      ),
    ).toBe('Photo');
  });

  it('reads a raw-key GIF body as GIF', () => {
    expect(
      readableMessageBody(MessageKind.Gif, 'messages:attachments.fallbackText'),
    ).toBe('GIF');
  });

  it('labels an attachment by its own kind whichever raw key it holds', () => {
    expect(
      readableMessageBody(
        MessageKind.Document,
        'messages:attachments.fallbackText',
      ),
    ).toBe('File');
    expect(
      readableMessageBody(
        MessageKind.Image,
        'messages:attachments.documentFallbackText',
      ),
    ).toBe('Photo');
  });

  it('keeps a translated attachment label as it was stored', () => {
    expect(readableMessageBody(MessageKind.Image, 'Foto')).toBe('Foto');
    expect(readableMessageBody(MessageKind.Document, 'Ficheiro')).toBe(
      'Ficheiro',
    );
    expect(readableMessageBody(MessageKind.Gif, 'GIF')).toBe('GIF');
  });

  it('keeps a text message that quotes a raw key word for word', () => {
    expect(
      readableMessageBody(
        MessageKind.User,
        'messages:attachments.documentFallbackText',
      ),
    ).toBe('messages:attachments.documentFallbackText');
  });

  it('keeps an ordinary text body unchanged', () => {
    expect(readableMessageBody(MessageKind.User, 'See you at nine')).toBe(
      'See you at nine',
    );
  });

  it('reads every sticker body as empty, a legacy edit included', () => {
    expect(readableMessageBody(MessageKind.Sticker, '')).toBe('');
    expect(
      readableMessageBody(MessageKind.Sticker, 'typed before the fix'),
    ).toBe('');
  });
});

describe('readableMessageEditedAt', () => {
  const EDITED_AT = new Date('2026-09-01T10:00:00.000Z');

  it('reads a sticker as never edited, a legacy edit included', () => {
    expect(readableMessageEditedAt(MessageKind.Sticker, EDITED_AT)).toBeNull();
  });

  it('keeps the edit timestamp of every other kind', () => {
    expect(readableMessageEditedAt(MessageKind.User, EDITED_AT)).toBe(
      '2026-09-01T10:00:00.000Z',
    );
    expect(readableMessageEditedAt(MessageKind.Image, EDITED_AT)).toBe(
      '2026-09-01T10:00:00.000Z',
    );
  });

  it('reads an unedited message as null', () => {
    expect(readableMessageEditedAt(MessageKind.User, null)).toBeNull();
  });
});
