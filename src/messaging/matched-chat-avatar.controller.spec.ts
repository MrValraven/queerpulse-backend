import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { PassThrough } from 'stream';
import type { StorageService } from '../storage/storage.service';
import { MatchedChatAvatarController } from './matched-chat-avatar.controller';
import type { MatchedChatMembersService } from './matched-chat-members.service';

/**
 * PRD-423 (opaque member keys): the matched chat avatar relay reaches only
 * the image hosts every write path allows, over https, with no redirect.
 */

const CHAT = '4f1c7a52-9a3e-4d4b-8f5e-2b6c1d0e9a11';
const MEMBER_KEY = 'm-2f8b6d1a4c93e75b0d6a2f19';

function build(externalUrl: string) {
  const matchedChatMembers = {
    resolveAvatar: jest.fn().mockResolvedValue({ externalUrl }),
  };
  const controller = new MatchedChatAvatarController(
    matchedChatMembers as unknown as MatchedChatMembersService,
    {} as StorageService,
  );
  const response = Object.assign(new PassThrough(), {
    setHeader: jest.fn(),
    status: jest.fn(),
  });
  response.status.mockReturnValue(response);
  return { controller, response: response as unknown as Response };
}

describe('MatchedChatAvatarController provider relay', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(
      new globalThis.Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
      }),
    );
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('refuses a stored URL off the image host allow-list without fetching it', async () => {
    const { controller, response } = build('https://evil.example/pixel.jpg');

    await expect(
      controller.avatar(CHAT, MEMBER_KEY, { userId: 'u1' } as never, response),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses plain http even on an allowed host', async () => {
    const { controller, response } = build(
      'http://lh3.googleusercontent.com/a/photo',
    );

    await expect(
      controller.avatar(CHAT, MEMBER_KEY, { userId: 'u1' } as never, response),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches an allowed https host with redirects refused', async () => {
    const { controller, response } = build(
      'https://lh3.googleusercontent.com/a/photo',
    );

    await controller.avatar(
      CHAT,
      MEMBER_KEY,
      { userId: 'u1' } as never,
      response,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://lh3.googleusercontent.com/a/photo',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
