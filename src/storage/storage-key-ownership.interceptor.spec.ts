import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { of } from 'rxjs';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { StorageKeyOwnershipInterceptor } from './storage-key-ownership.interceptor';

const OWN_USER_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555';
const FILE_SEGMENT = '66666666-7777-8888-9999-000000000000';

const OWN_KEY = `avatars/${OWN_USER_ID}/${FILE_SEGMENT}.jpg`;
const OTHER_USER_KEY = `avatars/${OTHER_USER_ID}/${FILE_SEGMENT}.jpg`;

function httpContext(
  method: string,
  body: unknown,
  user: { userId: string } | undefined,
  // Defaults to a handler that is NOT on `SHARED_UPLOAD_HANDLERS`, so every
  // existing case exercises the STRICT rule.
  handler: { controller: string; method: string } = {
    controller: 'ProfilesController',
    method: 'update',
  },
): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => ({ name: handler.controller }),
    getHandler: () => ({ name: handler.method }),
    switchToHttp: () => ({ getRequest: () => ({ method, body, user }) }),
  } as unknown as ExecutionContext;
}

const RESULT = { ok: true };
const nextHandler = (): CallHandler => ({ handle: () => of(RESULT) });

describe('StorageKeyOwnershipInterceptor', () => {
  let interceptor: StorageKeyOwnershipInterceptor;

  beforeEach(() => {
    interceptor = new StorageKeyOwnershipInterceptor();
  });

  it('passes a body containing the requester own key', (done) => {
    const ctx = httpContext(
      'PATCH',
      { avatarUrl: OWN_KEY },
      {
        userId: OWN_USER_ID,
      },
    );
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  it('rejects a body containing another user key', () => {
    const ctx = httpContext(
      'PATCH',
      { avatarUrl: OTHER_USER_KEY },
      {
        userId: OWN_USER_ID,
      },
    );
    expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
      ForbiddenException,
    );
  });

  it('does not leak the other user id in the rejection message', () => {
    const ctx = httpContext(
      'PATCH',
      { avatarUrl: OTHER_USER_KEY },
      {
        userId: OWN_USER_ID,
      },
    );
    try {
      interceptor.intercept(ctx, nextHandler());
      fail('expected ForbiddenException');
    } catch (error) {
      expect((error as ForbiddenException).message).not.toContain(
        OTHER_USER_ID,
      );
    }
  });

  it('catches a foreign key nested inside an object', () => {
    const ctx = httpContext(
      'PATCH',
      { photos: { wide: OTHER_USER_KEY } },
      { userId: OWN_USER_ID },
    );
    expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
      ForbiddenException,
    );
  });

  it('catches a foreign key nested inside an array of objects (work items)', () => {
    const ctx = httpContext(
      'PUT',
      {
        items: [
          { title: 'a', imageUrl: OWN_KEY },
          { title: 'b', imageUrl: OTHER_USER_KEY },
        ],
      },
      { userId: OWN_USER_ID },
    );
    expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
      ForbiddenException,
    );
  });

  it('catches a foreign key nested inside an array of objects (listing photos)', () => {
    const ctx = httpContext(
      'PATCH',
      { photos: [{ wide: OWN_KEY }, { d1: OTHER_USER_KEY }] },
      { userId: OWN_USER_ID },
    );
    expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
      ForbiddenException,
    );
  });

  it('passes an external https:// URL untouched', (done) => {
    const ctx = httpContext(
      'PATCH',
      { avatarUrl: 'https://lh3.googleusercontent.com/a/photo.jpg' },
      { userId: OWN_USER_ID },
    );
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  it('passes a plain string untouched', (done) => {
    const ctx = httpContext(
      'PATCH',
      { title: 'just some ordinary text, not a key' },
      { userId: OWN_USER_ID },
    );
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  it('skips a GET request even with a foreign key-shaped body', (done) => {
    const ctx = httpContext(
      'GET',
      { avatarUrl: OTHER_USER_KEY },
      {
        userId: OWN_USER_ID,
      },
    );
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  it('skips non-http contexts', (done) => {
    const ctx = {
      getType: () => 'ws',
    } as unknown as ExecutionContext;
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  it('skips a request with no body', (done) => {
    const ctx = httpContext('POST', undefined, { userId: OWN_USER_ID });
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  it('rejects a request with no authenticated user but a key in the body', () => {
    const ctx = httpContext('PATCH', { avatarUrl: OWN_KEY }, undefined);
    expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
      ForbiddenException,
    );
  });

  it('passes an anonymous request whose body has no storage key', (done) => {
    const ctx = httpContext('POST', { title: 'hello' }, undefined);
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  it('does not hang or overflow on a cyclic body', (done) => {
    const cyclic: Record<string, unknown> = { avatarUrl: OWN_KEY };
    cyclic.self = cyclic;
    const ctx = httpContext('PATCH', cyclic, { userId: OWN_USER_ID });
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  it('does not overflow the stack on a deeply nested body, and rejects it instead', () => {
    let nested: unknown = OTHER_USER_KEY;
    for (let level = 0; level < 1000; level += 1) {
      nested = { child: nested };
    }
    const ctx = httpContext('PATCH', nested, { userId: OWN_USER_ID });
    // The foreign key sits far past the depth cap. A silent return here
    // would be a bypass (the key would never be reached and would sail
    // through unchecked), so the overflow must fail closed by throwing
    // rather than fail open by returning. This also proves the cap itself
    // is what prevents a stack overflow rather than accidentally still
    // exhaustively walking a deep body.
    expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
      ForbiddenException,
    );
  });

  it('passes a body nested within the depth cap containing only the requester own keys', (done) => {
    let nested: unknown = OWN_KEY;
    for (let level = 0; level < 9; level += 1) {
      nested = { child: nested };
    }
    const ctx = httpContext('PATCH', nested, { userId: OWN_USER_ID });
    interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
      expect(value).toBe(RESULT);
      done();
    });
  });

  describe('normalizing our own resolved image URLs', () => {
    const BASE = 'http://localhost:3000';

    beforeEach(() => setImageUrlBase(BASE));
    afterEach(() => resetImageUrlBaseForTesting());

    it('rewrites our own resolved URL back to the bare key, in place, and passes', (done) => {
      const body = { avatarUrl: `${BASE}/files/${OWN_KEY}` };
      const ctx = httpContext('PATCH', body, { userId: OWN_USER_ID });
      interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
        expect(value).toBe(RESULT);
        // The derived URL never reaches the service/DB — it is collapsed to the
        // canonical storage key so the round-trip stays idempotent.
        expect(body.avatarUrl).toBe(OWN_KEY);
        done();
      });
    });

    it("rejects another member's resolved URL on an ordinary handler", () => {
      // The bug this replaced: `/files/<key>` was treated as "server-issued and
      // therefore trusted", but that URL is exactly what every `<img src>` on
      // every page carries — so any member could copy another member's avatar
      // URL out of the DOM and PATCH it onto their own profile.
      const body = { avatarUrl: `${BASE}/files/${OTHER_USER_KEY}` };
      const ctx = httpContext('PATCH', body, { userId: OWN_USER_ID });
      expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
        ForbiddenException,
      );
    });

    it("normalizes a co-editor's resolved URL on an enumerated shared handler", (done) => {
      // A community is edited by every one of its moderators, and the cover was
      // uploaded by whichever one sourced it. See `shared-upload-handlers.ts`.
      const body = { coverImageUrl: `${BASE}/files/${OTHER_USER_KEY}` };
      const ctx = httpContext(
        'PATCH',
        body,
        { userId: OWN_USER_ID },
        { controller: 'CommunitiesController', method: 'update' },
      );
      interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
        expect(value).toBe(RESULT);
        expect(body.coverImageUrl).toBe(OTHER_USER_KEY);
        done();
      });
    });

    it('still rejects a BARE foreign key on a shared handler', () => {
      // The exemption covers only the resolved-URL form (an image the requester
      // was actually shown), never a bare key they could have guessed.
      const ctx = httpContext(
        'PATCH',
        { coverImageUrl: OTHER_USER_KEY },
        { userId: OWN_USER_ID },
        { controller: 'CommunitiesController', method: 'update' },
      );
      expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
        ForbiddenException,
      );
    });

    it('still rejects a BARE foreign key even when a base URL is set', () => {
      const ctx = httpContext(
        'PATCH',
        { avatarUrl: OTHER_USER_KEY },
        { userId: OWN_USER_ID },
      );
      expect(() => interceptor.intercept(ctx, nextHandler())).toThrow(
        ForbiddenException,
      );
    });

    it('rewrites resolved URLs nested in an array (collection full-replace)', (done) => {
      const body = { items: [{ imageUrl: `${BASE}/files/${OWN_KEY}` }] };
      const ctx = httpContext('PUT', body, { userId: OWN_USER_ID });
      interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
        expect(value).toBe(RESULT);
        expect(body.items[0]!.imageUrl).toBe(OWN_KEY);
        done();
      });
    });

    it('leaves an external https:// URL untouched', (done) => {
      const external = 'https://images.unsplash.com/photo.jpg';
      const body = { avatarUrl: external };
      const ctx = httpContext('PATCH', body, { userId: OWN_USER_ID });
      interceptor.intercept(ctx, nextHandler()).subscribe((value) => {
        expect(value).toBe(RESULT);
        expect(body.avatarUrl).toBe(external);
        done();
      });
    });
  });
});
