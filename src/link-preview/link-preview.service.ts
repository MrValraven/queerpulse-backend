import { Injectable } from '@nestjs/common';
import {
  LinkPreviewResponse,
  emptyPreview,
} from './link-preview.response';
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
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
