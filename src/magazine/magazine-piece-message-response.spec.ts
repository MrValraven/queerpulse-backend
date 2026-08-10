import { MagazinePieceMessage } from './entities/magazine-piece-message.entity';
import {
  toPieceMessage,
  UNRESOLVED_MESSAGE_AUTHOR_LABEL,
} from './magazine-piece-message-response';

function makeMessage(
  overrides: Partial<MagazinePieceMessage> = {},
): MagazinePieceMessage {
  return {
    id: 'message-1',
    pieceId: 'piece-1',
    authorId: 'user-1',
    body: 'Can you send the final word count?',
    createdAt: new Date('2026-08-10T09:00:00Z'),
    ...overrides,
  };
}

describe('toPieceMessage', () => {
  it('marks fromMe true when the message author is the requesting user', () => {
    const message = makeMessage({ authorId: 'writer-1' });

    const result = toPieceMessage(
      message,
      new Map([['writer-1', 'Kai Duarte']]),
      'writer-1',
    );

    expect(result.fromMe).toBe(true);
  });

  it('marks fromMe false when the message author is a different user', () => {
    const message = makeMessage({ authorId: 'editor-1' });

    const result = toPieceMessage(
      message,
      new Map([['editor-1', 'Marta Nogueira']]),
      'writer-1',
    );

    expect(result.fromMe).toBe(false);
  });

  it('resolves the author display name from the passed map, never the raw id or an email', () => {
    const message = makeMessage({ authorId: 'user-42' });

    const result = toPieceMessage(
      message,
      new Map([['user-42', 'Ana Silva']]),
      'user-42',
    );

    expect(result.author).toBe('Ana Silva');
    expect(result.author).not.toContain('user-42');
    expect(result.author).not.toContain('@');
    expect(JSON.stringify(result)).not.toContain('user-42');
  });

  it('falls back to a neutral label when the author id is missing from the map, never leaking it', () => {
    const message = makeMessage({ authorId: 'ghost-1' });

    const result = toPieceMessage(message, new Map(), 'someone-else');

    expect(result.author).toBe(UNRESOLVED_MESSAGE_AUTHOR_LABEL);
    expect(result.author).not.toContain('ghost-1');
  });

  it('maps id/body/createdAt (ISO) straight through', () => {
    const message = makeMessage();

    const result = toPieceMessage(
      message,
      new Map([['user-1', 'Ana Silva']]),
      'user-1',
    );

    expect(result).toEqual({
      id: 'message-1',
      author: 'Ana Silva',
      body: 'Can you send the final word count?',
      createdAt: '2026-08-10T09:00:00.000Z',
      fromMe: true,
    });
  });
});
