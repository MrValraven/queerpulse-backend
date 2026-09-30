import { Injectable } from '@nestjs/common';
import {
  type ConditionalValidators,
  type FeedFetchResult,
  fetchFeedImage,
  fetchFeedXml,
} from './feed-fetch';

/**
 * The network seam of persona feed import, as a provider so the service specs
 * can replace it. Both calls go through the SSRF-hardened `safeFetch`.
 */
@Injectable()
export class SubprofileFeedFetcher {
  fetchFeed(
    url: string,
    validators: ConditionalValidators | null,
  ): Promise<FeedFetchResult> {
    return fetchFeedXml(url, validators);
  }

  fetchImage(
    url: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return fetchFeedImage(url);
  }
}
