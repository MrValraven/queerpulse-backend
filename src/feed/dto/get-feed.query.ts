import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// `tab` values the frontend's `feed.data.ts#FEED_TABS` maps onto, via
// `feed.api.ts#tabParam` ("All" -> undefined/omitted, which we treat as
// "all"). See `feed.service.ts#sourcesForTab` for what each tab includes.
export const FEED_TABS = [
  'all',
  'communities',
  'connections',
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

  /**
   * PRD-168: bound the new-member sources to members who joined within this
   * many days. Affects `new_member`/`community_new_member` and nothing else,
   * so a post or a gathering is never filtered by it.
   *
   * The sidebar's "New this week" widget passes `7`. It reads the People tab,
   * which returns the newest active members with no date bound of its own, so
   * on a quiet week the widget showed people who joined months ago under a
   * heading that promises this week. With the bound it returns an honest
   * empty list instead. The People TAB itself omits this and is unchanged.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  joinedWithinDays?: number;

  /**
   * PRD-107 / CON-16: the reader's chosen language, for the `magazine_article`
   * source alone. A piece with a published translation in it is shown in that
   * language; a piece without one stays as written, and every other source
   * ignores this entirely.
   *
   * Not validated against the magazine's locale list on purpose: a member
   * whose chrome is in a language the magazine does not publish in must get
   * their feed, not a 400. `magazine-locale.ts#toArticleLocale` narrows the
   * value and treats anything else as "no preference". Length-capped so it
   * stays a language tag.
   */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  lang?: string;
}
