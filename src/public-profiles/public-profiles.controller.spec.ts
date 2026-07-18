import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { PublicProfileResponse } from './public-profile-response';
import { PublicProfilesController } from './public-profiles.controller';
import { PublicProfilesService } from './public-profiles.service';

describe('PublicProfilesController', () => {
  let controller: PublicProfilesController;
  let service: { getBySlug: jest.Mock };
  let res: Response;
  let headers: Record<string, unknown>;

  const view: PublicProfileResponse = {
    slug: 'ada',
    displayName: 'Ada Lovelace',
    pronouns: 'she/her',
    tagline: 'Building queer software',
    avatarUrl: null,
    bio: null,
    socials: [],
    work: [],
  };

  beforeEach(async () => {
    service = { getBySlug: jest.fn().mockResolvedValue(view) };
    headers = {};
    res = {
      setHeader: jest.fn((name: string, value: unknown) => {
        headers[name] = value;
      }),
    } as unknown as Response;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicProfilesController],
      providers: [{ provide: PublicProfilesService, useValue: service }],
    }).compile();

    controller = module.get(PublicProfilesController);
  });

  it('returns the published projection for a slug', async () => {
    const result = await controller.getBySlug('ada', res);

    expect(service.getBySlug).toHaveBeenCalledWith('ada');
    expect(result).toEqual(view);
  });

  describe('caching', () => {
    // An un-publish has to take effect immediately; nothing may hold a copy.
    it('sends Cache-Control: no-store on a published profile', async () => {
      await controller.getBySlug('ada', res);

      expect(headers['Cache-Control']).toBe('no-store');
    });

    // Set before the lookup precisely so it survives the throw — a cached 404
    // would otherwise outlive a member turning publication ON.
    it('sends Cache-Control: no-store on the 404 path too', async () => {
      service.getBySlug.mockRejectedValue(new NotFoundException());

      await expect(controller.getBySlug('ada', res)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(headers['Cache-Control']).toBe('no-store');
    });
  });

  describe('route metadata', () => {
    const reflector = new Reflector();
    // Read as a metadata target only — never invoked, so the unbound `this`
    // the rule warns about cannot arise.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = PublicProfilesController.prototype.getBySlug;

    it('is unauthenticated by design', () => {
      expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
    });

    // Enumeration control. Tightened well below the global 120/60s default
    // because slugs are guessable and a 200-vs-404 split reveals membership.
    //
    // The metadata keys are spelled out because @nestjs/throttler does not
    // re-export `throttler.constants` from its package root; `@Throttle` writes
    // `THROTTLER:LIMIT` + the throttler name onto the handler (verified against
    // @nestjs/throttler 6.5.0). `seconds(60)` is 60000ms.
    it('is throttled to 30 requests per 60s', () => {
      expect(reflector.get('THROTTLER:LIMITdefault', handler)).toBe(30);
      expect(reflector.get('THROTTLER:TTLdefault', handler)).toBe(60000);
    });
  });
});
