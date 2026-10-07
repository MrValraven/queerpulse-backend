import {
  HEADERS_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import {
  NO_STALE_READ_CDN_CACHE,
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';
import {
  AnonymousNoStaleCacheInterceptor,
  AnonymousPublicCacheInterceptor,
} from '../subprofiles/anonymous-public-cache.interceptor';
import { DirectoryController } from './directory.controller';

/**
 * Which CDN freshness each public directory read declares. Every read that can
 * carry a listing its owner has since paused or moved into the 18+ category
 * (or a badge since suspended) must drop the CDN stale window, so a logged-out
 * visitor stops being served it within about a minute.
 */

type DirectoryHandlerName = keyof DirectoryController;

function handlerOf(handlerName: DirectoryHandlerName): object {
  return Object.getOwnPropertyDescriptor(
    DirectoryController.prototype,
    handlerName,
  )?.value as object;
}

function declaredHeaders(
  handlerName: DirectoryHandlerName,
): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  const metadata = (Reflect.getMetadata(
    HEADERS_METADATA,
    handlerOf(handlerName),
  ) ?? []) as { name: string; value: unknown }[];
  for (const { name, value } of metadata) headers[name] = value;
  return headers;
}

describe('DirectoryController cache headers', () => {
  it('serves the partner spaces with no CDN stale window', () => {
    expect(declaredHeaders('listPartnerSpaces')).toEqual({
      'Cache-Control': PUBLIC_READ_CACHE,
      'CDN-Cache-Control': 'public, s-maxage=60',
    });
  });

  it('keeps the stale window on the static tag vocabulary', () => {
    expect(declaredHeaders('listTagVocabulary')).toEqual({
      'Cache-Control': PUBLIC_READ_CACHE,
      'CDN-Cache-Control': PUBLIC_READ_CDN_CACHE,
    });
  });

  it.each([
    'listDirectory',
    'listSafeSpaces',
    'getSafeSpace',
    'listByMember',
  ] as const)('serves %s with no CDN stale window', (handlerName) => {
    expect(declaredHeaders(handlerName)['CDN-Cache-Control']).toBe(
      NO_STALE_READ_CDN_CACHE,
    );
  });

  it.each(['getDirectoryListing', 'listReviews', 'listQuestions'] as const)(
    '%s uses the no-stale anonymous cache interceptor',
    (handlerName) => {
      const interceptors = Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        handlerOf(handlerName),
      ) as unknown[];
      expect(interceptors).toEqual([AnonymousNoStaleCacheInterceptor]);
      expect(interceptors).not.toContain(AnonymousPublicCacheInterceptor);
      // The interceptor owns these headers; a static pair would fight it.
      expect(
        Reflect.getMetadata(HEADERS_METADATA, handlerOf(handlerName)),
      ).toBeUndefined();
    },
  );
});
