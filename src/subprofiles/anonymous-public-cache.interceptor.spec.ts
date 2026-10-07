import {
  CallHandler,
  ExecutionContext,
  NotFoundException,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import {
  NO_STALE_READ_CDN_CACHE,
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';
import {
  AnonymousNoStaleCacheInterceptor,
  AnonymousPublicCacheInterceptor,
} from './anonymous-public-cache.interceptor';

/**
 * The shared anonymous-cache interceptor and its no-stale directory variant.
 * The variant must change ONE header on ONE branch (the anonymous
 * `CDN-Cache-Control`) and inherit everything else, so the subprofile
 * surfaces on the original keep their five-minute stale window while the
 * directory detail reads drop it.
 */

interface MockResponse {
  setHeader: jest.Mock;
  vary: jest.Mock;
}

function makeContext(user: unknown): {
  context: ExecutionContext;
  response: MockResponse;
} {
  const response: MockResponse = { setHeader: jest.fn(), vary: jest.fn() };
  const request = user === undefined ? {} : { user };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, response };
}

/** The last value each header was set to, keyed by header name. */
function headersSet(response: MockResponse): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  for (const [name, value] of response.setHeader.mock.calls as [
    string,
    unknown,
  ][]) {
    headers[name] = value;
  }
  return headers;
}

const succeedingHandler: CallHandler = { handle: () => of('body') };

describe('AnonymousPublicCacheInterceptor', () => {
  it('keeps the CDN stale window for an anonymous caller', async () => {
    const { context, response } = makeContext(undefined);
    await firstValueFrom(
      new AnonymousPublicCacheInterceptor().intercept(
        context,
        succeedingHandler,
      ),
    );
    expect(headersSet(response)).toEqual({
      'Cache-Control': PUBLIC_READ_CACHE,
      'CDN-Cache-Control': PUBLIC_READ_CDN_CACHE,
    });
    expect(PUBLIC_READ_CDN_CACHE).toBe(
      'public, s-maxage=60, stale-while-revalidate=300',
    );
    expect(response.vary).toHaveBeenCalledWith('Cookie');
  });

  it('sends private, no-store on both headers for a signed-in caller', async () => {
    const { context, response } = makeContext({ userId: 'member-1' });
    await firstValueFrom(
      new AnonymousPublicCacheInterceptor().intercept(
        context,
        succeedingHandler,
      ),
    );
    expect(headersSet(response)).toEqual({
      'Cache-Control': 'private, no-store',
      'CDN-Cache-Control': 'private, no-store',
    });
    expect(response.vary).toHaveBeenCalledWith('Cookie');
  });
});

describe('AnonymousNoStaleCacheInterceptor', () => {
  it('drops the CDN stale window for an anonymous caller', async () => {
    const { context, response } = makeContext(undefined);
    await firstValueFrom(
      new AnonymousNoStaleCacheInterceptor().intercept(
        context,
        succeedingHandler,
      ),
    );
    expect(headersSet(response)).toEqual({
      'Cache-Control': PUBLIC_READ_CACHE,
      'CDN-Cache-Control': 'public, s-maxage=60',
    });
    expect(NO_STALE_READ_CDN_CACHE).toBe('public, s-maxage=60');
    expect(response.vary).toHaveBeenCalledWith('Cookie');
  });

  it('sends private, no-store on both headers for a signed-in caller', async () => {
    const { context, response } = makeContext({ userId: 'member-1' });
    await firstValueFrom(
      new AnonymousNoStaleCacheInterceptor().intercept(
        context,
        succeedingHandler,
      ),
    );
    expect(headersSet(response)).toEqual({
      'Cache-Control': 'private, no-store',
      'CDN-Cache-Control': 'private, no-store',
    });
    expect(response.vary).toHaveBeenCalledWith('Cookie');
  });

  it('inherits the moved-response downgrade to no-store', async () => {
    const { context, response } = makeContext(undefined);
    const movedError = new NotFoundException({ code: 'PERSONA_MOVED' });
    const failingHandler: CallHandler = {
      handle: () => throwError(() => movedError),
    };
    await expect(
      firstValueFrom(
        new AnonymousNoStaleCacheInterceptor().intercept(
          context,
          failingHandler,
        ),
      ),
    ).rejects.toBe(movedError);
    expect(headersSet(response)).toEqual({
      'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store',
    });
  });

  it('leaves a plain 404 on the anonymous headers and rethrows it', async () => {
    const { context, response } = makeContext(undefined);
    const plainError = new NotFoundException('Listing not found');
    const failingHandler: CallHandler = {
      handle: () => throwError(() => plainError),
    };
    await expect(
      firstValueFrom(
        new AnonymousNoStaleCacheInterceptor().intercept(
          context,
          failingHandler,
        ),
      ),
    ).rejects.toBe(plainError);
    expect(headersSet(response)).toEqual({
      'Cache-Control': PUBLIC_READ_CACHE,
      'CDN-Cache-Control': NO_STALE_READ_CDN_CACHE,
    });
  });
});
