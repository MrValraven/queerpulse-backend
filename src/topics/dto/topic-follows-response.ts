import { TopicFollow } from '../entities/topic-follow.entity';

/**
 * Hand-mapped response for `GET /topics/follows` — the caller's followed topic
 * slugs, most-recently-followed first. Deliberately NOT the raw `TopicFollow`
 * rows: the frontend only needs the set of slugs to seed each topic header's
 * follow button, so ids/userId/createdAt never cross the wire (no global
 * serializer here — map entities to DTOs by hand or leak columns).
 */
export interface TopicFollowsResponse {
  slugs: string[];
}

export function toTopicFollowsResponse(
  follows: TopicFollow[],
): TopicFollowsResponse {
  return { slugs: follows.map((follow) => follow.topicSlug) };
}
