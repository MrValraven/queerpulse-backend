import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Response } from 'express';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Message } from '../messaging/entities/message.entity';
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

const LOGGED_IN = { userId: USER_SEGMENT, email: 'member@example.com' };
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
      expect(storage.createPresignedDownload).toHaveBeenCalledWith(key);
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
      expect(storage.createPresignedDownload).toHaveBeenCalledWith(AVATAR_KEY);
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('still resolves when handed a single string param (defensive)', async () => {
      await controller.serve(AVATAR_KEY, null, response as unknown as Response);
      expect(storage.createPresignedDownload).toHaveBeenCalledWith(AVATAR_KEY);
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
