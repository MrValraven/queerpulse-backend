import { Injectable } from '@nestjs/common';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { MAX_BATCH_URLS } from './link-preview.constants';
import { LinkPreviewResponse, emptyPreview } from './link-preview.response';
import { parseOpenGraph } from './og-parse';
import { safeFetchHtml } from './ssrf';

interface CacheEntry {
  value: LinkPreviewResponse;
  expiresAt: number;
}

/**
 * Resolves an unfurl for a URL: SSRF-safe fetch → OpenGraph parse → hand-mapped
 * DTO, behind a short in-memory TTL cache so the same link pasted into a busy
 * thread (or re-requested as messages re-render) fetches once, not once per
 * viewer. The cache is intentionally in-process and bounded — there's NO
 * database table for previews (fetch-on-demand + TTL is enough; adding a
 * migration would be over-engineering for cacheable, re-derivable public
 * metadata). A card with no usable metadata is cached too, so a dud link isn't
 * re-fetched on every render.
 */
@Injectable()
export class LinkPreviewService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 10 * 60 * 1000; // 10 minutes
  private readonly maxEntries = 500;

  async preview(url: string): Promise<LinkPreviewResponse> {
    const cached = this.readCache(url);
    if (cached) return cached;

    const fetched = await safeFetchHtml(url);
    // SSRF-declined, unreachable, non-HTML, or over cap → an empty card. The
    // client renders nothing; we cache the miss so we don't retry every render.
    const preview = fetched
      ? parseOpenGraph(fetched.html, fetched.finalUrl)
      : emptyPreview(url);

    this.writeCache(url, preview);
    return preview;
  }

  /**
   * Unfurl several URLs for one page render (a forum thread or a feed page can
   * quote a handful at once). Results come back in the order they were asked
   * for, so the caller can zip them against its own list without matching on
   * the `url` field, which holds the POST-REDIRECT address and may differ from
   * what was requested.
   *
   * Bounded by `runWithConcurrency` rather than a bare `Promise.all`: each URL
   * opens an outbound socket, and the shared helper is the repo's one way of
   * capping a fan-out. `MAX_BATCH_URLS` is also the DTO's hard cap, so in
   * practice every URL in a valid batch starts at once and the whole call costs
   * the slowest fetch instead of the sum.
   *
   * A duplicate URL inside one batch is fetched once by the TTL cache only if
   * the first has already resolved; simultaneous duplicates each fetch. That is
   * the caller's to avoid, and it is charged for either way (see
   * `LinkPreviewThrottlerGuard`).
   */
  previewMany(urls: string[]): Promise<LinkPreviewResponse[]> {
    return runWithConcurrency(
      urls.map((url) => () => this.previewNeverThrows(url)),
      MAX_BATCH_URLS,
    );
  }

  /**
   * `preview` is written not to throw for any "can't unfurl this" case, but one
   * rejecting entry would abort a whole batch, so the batch path belts and
   * braces it: an unexpected failure becomes an empty card for that URL and the
   * other links in the thread still render.
   */
  private async previewNeverThrows(url: string): Promise<LinkPreviewResponse> {
    try {
      return await this.preview(url);
    } catch {
      return emptyPreview(url);
    }
  }

  private readCache(url: string): LinkPreviewResponse | null {
    const entry = this.cache.get(url);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(url);
      return null;
    }
    return entry.value;
  }

  private writeCache(url: string, value: LinkPreviewResponse): void {
    // Cheap bound: when full, evict the oldest insertion (Map preserves order).
    if (this.cache.size >= this.maxEntries) {
      for (const oldest of this.cache.keys()) {
        this.cache.delete(oldest);
        break;
      }
    }
    this.cache.set(url, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
