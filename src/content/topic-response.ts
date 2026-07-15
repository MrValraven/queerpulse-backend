import { Topic } from './entities/topic.entity';

/**
 * The shape returned by `GET /topics` — a lightweight directory entry per
 * hashtag topic. There is no `contracts.ts` type for this (the `topics`
 * feature is demo-only and calls no `*.api.ts`), so this is derived directly
 * from the FE mock's `Topic` interface in
 * `queerpulse/src/features/topics/topics.data.tsx`, keeping only the
 * plain-data fields (dropping the JSX-only `title`/`sub`, the post feed, top
 * voices, and curated resources — see the module report for why).
 */
export interface TopicResponse {
  tag: string;
  label: string;
  description: string;
  totalPosts: number;
  crisisCard: boolean;
}

export function toTopicResponse(topic: Topic): TopicResponse {
  return {
    tag: topic.tag,
    label: topic.label,
    description: topic.description,
    totalPosts: topic.totalPosts,
    crisisCard: topic.crisisCard,
  };
}

/** One entry of `TopicDetailResponse.relatedTopics` — mirrors the mock's
 * `RelatedTopic` (`{ tag, count }`) in `topics.data.tsx`. */
export interface RelatedTopicResponse {
  tag: string;
  count: number;
}

/**
 * The shape returned by `GET /topics/:slug` — everything `TopicHeader` /
 * `TopicSidebar` need beyond the directory entry: the follower count, how
 * many posts landed this week, and the related-topics list. Does NOT
 * include `topVoices` or the curated `resources` panel — no backend shape
 * was requested for those; see `entities/topic.entity.ts`'s docstring.
 */
export interface TopicDetailResponse extends TopicResponse {
  followerCount: number;
  postsThisWeek: number;
  relatedTopics: RelatedTopicResponse[];
}

export function toTopicDetailResponse(
  topic: Topic,
  relatedTopics: RelatedTopicResponse[],
  postsThisWeek: number,
): TopicDetailResponse {
  return {
    ...toTopicResponse(topic),
    followerCount: topic.followerCount,
    postsThisWeek,
    relatedTopics,
  };
}
