import { FeedSourceKind } from './entities/feed-source-mute.entity';

/**
 * One row of the member's managed "sources you've turned down" list
 * (`GET /feed/mutes`, SOC-18). Hand-mapped like every other response in this
 * repo: there is no global serializer, so returning the entity would leak the
 * row id and `user_id`.
 *
 * `name` and `link` are resolved from the subject so the list reads as places
 * ("Trans & Non-Binary Network") rather than uuids, and each entry can be
 * opened to see what is actually being missed before deciding to unmute.
 */
export interface FeedMutedSourceResponse {
  sourceKind: FeedSourceKind;
  sourceId: string;
  name: string;
  link: string;
  mutedAt: string;
}
