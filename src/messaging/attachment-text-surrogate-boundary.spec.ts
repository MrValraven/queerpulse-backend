// The gateway imports the `cookie` package (v2), which is ESM-only and which
// ts-jest cannot load. Mocked exactly like `edit-message-caption.spec.ts`.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { maxLength } from 'class-validator';
import { MAX_ATTACHMENT_CAPTION_LENGTH } from './messaging.constants';
import { MessagingCoreService } from './messaging-core.service';

/**
 * A caption or document name that ends in an emoji at the length bound is
 * stored whole, and a longer one is cut between characters. A cut through a
 * surrogate pair leaves a lone half, which `JSON.stringify` writes as
 * `\ud83d` and Postgres refuses in the `jsonb` attachment column, failing
 * the send or edit with a 500.
 */

const GRINNING_FACE = '\u{1F600}';

const sanitizeCaption = (caption: string | undefined) =>
  MessagingCoreService.prototype.sanitizeAttachmentCaption(caption);

const sanitizeFileName = (fileName: string): string =>
  MessagingCoreService.prototype['sanitizeDisplayFileName'](fileName);

/** Postgres refuses a `jsonb` value whose JSON text holds a lone surrogate escape. */
const hasLoneSurrogateEscape = (value: unknown): boolean =>
  /\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(value));

describe('sanitizeAttachmentCaption at the length bound', () => {
  it('stores a caption the DTO accepts whole when its last character is an emoji', () => {
    const caption =
      'a'.repeat(MAX_ATTACHMENT_CAPTION_LENGTH - 1) + GRINNING_FACE;
    expect(maxLength(caption, MAX_ATTACHMENT_CAPTION_LENGTH)).toBe(true);

    const stored = sanitizeCaption(caption);

    expect(stored).toBe(caption);
    expect(hasLoneSurrogateEscape({ caption: stored })).toBe(false);
  });

  it('stores an emoji-only caption within the bound whole', () => {
    const caption = GRINNING_FACE.repeat(MAX_ATTACHMENT_CAPTION_LENGTH);
    expect(maxLength(caption, MAX_ATTACHMENT_CAPTION_LENGTH)).toBe(true);

    expect(sanitizeCaption(caption)).toBe(caption);
  });

  it('cuts an over-long caption between characters with no lone surrogate', () => {
    const caption = 'a'.repeat(MAX_ATTACHMENT_CAPTION_LENGTH) + GRINNING_FACE;

    const stored = sanitizeCaption(caption);

    expect(stored).toBe('a'.repeat(MAX_ATTACHMENT_CAPTION_LENGTH));
    expect(hasLoneSurrogateEscape({ caption: stored })).toBe(false);
  });

  it('drops a lone surrogate a client sent directly', () => {
    expect(sanitizeCaption('Sunset\uD83D')).toBe('Sunset');
    expect(sanitizeCaption('\uD83D')).toBeUndefined();
  });
});

describe('sanitizeDisplayFileName at the length bound', () => {
  it('cuts a long document name between characters with no lone surrogate', () => {
    const fileName = 'a'.repeat(199) + GRINNING_FACE + '.pdf';

    const stored = sanitizeFileName(fileName);

    expect(stored).toBe('a'.repeat(199) + GRINNING_FACE);
    expect(hasLoneSurrogateEscape({ fileName: stored })).toBe(false);
  });
});
