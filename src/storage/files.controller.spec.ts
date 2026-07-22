import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Response } from 'express';
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

const LOGGED_IN = { userId: USER_SEGMENT, email: 'member@example.com' };

describe('FilesController', () => {
  let controller: FilesController;
  let storage: { createPresignedDownload: jest.Mock };
  let response: { redirect: jest.Mock; setHeader: jest.Mock };

  beforeEach(() => {
    storage = {
      createPresignedDownload: jest.fn().mockResolvedValue(PRESIGNED_DOWNLOAD),
    };
    response = { redirect: jest.fn(), setHeader: jest.fn() };
    controller = new FilesController(storage as unknown as StorageService);
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
    it('redirects for a logged-in member', async () => {
      await serve(GATHERING_KEY, LOGGED_IN);
      expect(response.redirect).toHaveBeenCalledWith(302, PRESIGNED_DOWNLOAD);
    });

    it('rejects an anonymous request', async () => {
      await expect(serve(GATHERING_KEY, null)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
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
