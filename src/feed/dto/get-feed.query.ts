import { IsIn, IsOptional, IsString } from 'class-validator';

// `tab` values the frontend's `feed.data.ts#FEED_TABS` maps onto, via
// `feed.api.ts#tabParam` ("All" -> undefined/omitted, which we treat as
// "all"). See `feed.service.ts#sourcesForTab` for what each tab includes.
export const FEED_TABS = [
  'all',
  'communities',
  'gatherings',
  'people',
  'posts',
] as const;
export type FeedTab = (typeof FEED_TABS)[number];

// `GET /feed?tab=&cursor=` query — matches `getFeed(tab, cursor)` in the
// frontend's `features/feed/api/feed.api.ts`.
export class GetFeedQuery {
  @IsOptional()
  @IsIn(FEED_TABS)
  tab?: FeedTab;

  @IsOptional()
  @IsString()
  cursor?: string;
}
