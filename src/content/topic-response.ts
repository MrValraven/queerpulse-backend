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
