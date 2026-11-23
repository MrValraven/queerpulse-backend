import { Injectable } from '@nestjs/common';
import { magicBytesMatchContentType } from '../storage/served-object';
import { LINK_PREVIEW_IMAGE_TYPES, safeFetchImage } from './ssrf';

/** An image the route may relay: bytes already checked against their type. */
export interface LinkPreviewImage {
  body: Buffer;
  contentType: string;
}

/**
 * The most distinct image fetches one process runs at once. Past it, a
 * request answers "unavailable" and nothing is cached, so the next render
 * tries again once the queue has drained. Each fetch holds a socket and up to
 * `LINK_PREVIEW_IMAGE_MAX_BYTES` in memory, so the cap bounds both.
 */
export const MAX_IN_FLIGHT_IMAGE_FETCHES = 16;

interface CacheEntry {
  value: LinkPreviewImage | null;
  expiresAt: number;
}

/**
 * SEC-23: fetches a link preview's image on the reader's behalf, so the host
 * behind it only ever sees QueerPulse's address.
 *
 * Every fetch goes through `safeFetchImage`: SSRF-checked hops, ports 80 and
 * 443 only, an image content type, a byte cap and a timeout. The bytes must
 * then match the declared type's magic bytes, so a page cannot pass HTML or
 * script off as a PNG.
 *
 * Results sit in a short in-process cache sized by total bytes. Readers of one
 * thread share a fetch, which also means the image host cannot count readers
 * or time each one: within the TTL it sees at most one request per image. A
 * miss (unreachable, wrong type, too big) is cached too, so a dud image is not
 * re-fetched for every bubble that renders it.
 */
@Injectable()
export class LinkPreviewImageService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 10 * 60 * 1000; // the unfurl cache's TTL
  private readonly maxCachedBytes = 32 * 1024 * 1024;
  private readonly maxEntries = 500;
  private cachedBytes = 0;

  /** Fetches already running, so readers who open a thread together share one. */
  private readonly inFlight = new Map<
    string,
    Promise<LinkPreviewImage | null>
  >();

  load(imageUrl: string): Promise<LinkPreviewImage | null> {
    const cached = this.readCache(imageUrl);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = this.inFlight.get(imageUrl);
    if (running) return running;
    if (this.inFlight.size >= MAX_IN_FLIGHT_IMAGE_FETCHES) {
      return Promise.resolve(null);
    }

    const fetching = this.fetchAndCache(imageUrl).finally(() => {
      this.inFlight.delete(imageUrl);
    });
    this.inFlight.set(imageUrl, fetching);
    return fetching;
  }

  private async fetchAndCache(
    imageUrl: string,
  ): Promise<LinkPreviewImage | null> {
    const fetched = await safeFetchImage(imageUrl);
    const image =
      fetched &&
      LINK_PREVIEW_IMAGE_TYPES.has(fetched.contentType) &&
      magicBytesMatchContentType(fetched.body, fetched.contentType)
        ? {
            // A view over the fetched bytes: no second copy of the image.
            body: Buffer.from(
              fetched.body.buffer,
              fetched.body.byteOffset,
              fetched.body.byteLength,
            ),
            contentType: fetched.contentType,
          }
        : null;

    this.writeCache(imageUrl, image);
    return image;
  }

  /** The cached answer, `null` for a cached miss, `undefined` when absent. */
  private readCache(imageUrl: string): LinkPreviewImage | null | undefined {
    const entry = this.cache.get(imageUrl);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.deleteEntry(imageUrl, entry);
      return undefined;
    }
    return entry.value;
  }

  private writeCache(imageUrl: string, value: LinkPreviewImage | null): void {
    const size = value?.body.byteLength ?? 0;
    if (size > this.maxCachedBytes) return;
    const previous = this.cache.get(imageUrl);
    if (previous) this.deleteEntry(imageUrl, previous);
    // Evict the oldest insertions (Map keeps order) until the new entry fits.
    for (const [oldestUrl, oldestEntry] of this.cache) {
      const isOverBudget =
        this.cachedBytes + size > this.maxCachedBytes ||
        this.cache.size >= this.maxEntries;
      if (!isOverBudget) break;
      this.deleteEntry(oldestUrl, oldestEntry);
    }
    this.cache.set(imageUrl, { value, expiresAt: Date.now() + this.ttlMs });
    this.cachedBytes += size;
  }

  private deleteEntry(imageUrl: string, entry: CacheEntry): void {
    this.cache.delete(imageUrl);
    this.cachedBytes -= entry.value?.body.byteLength ?? 0;
  }
}
