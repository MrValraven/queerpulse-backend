import { TopicPost } from './entities/topic-post.entity';

/**
 * The shape returned by `GET /topics/:slug/posts` — mirrors the frontend's
 * `TopicPost` interface (`queerpulse/src/features/topics/topics.data.tsx`)
 * field-for-field where that interface is plain data, and flattens the
 * JSX-only fields (`title`, `stats`) to their plain-text/structured
 * equivalents — see `entities/topic-post.entity.ts` for the modeling
 * rationale. `queerpulse/src/features/topics/api/topics.adapters.ts`
 * re-composes `stats`/`meta` back into `ReactNode` for `TopicPostCard`.
 */
export interface TopicPostResponse {
  id: string;
  topicId: string;
  author: string;
  authorInitials: string;
  authorTone: string;
  contextLabel: string | null;
  kind: string;
  category: string;
  title: string;
  body: string;
  reactionCount: number;
  reactionLabel: string;
  replyCount: number;
  replyLabel: string | null;
  tags: string[];
  href: string;
  createdAt: string;
}

export function toTopicPostResponse(post: TopicPost): TopicPostResponse {
  return {
    id: post.id,
    topicId: post.topicId,
    author: post.authorName,
    authorInitials: post.authorInitials,
    authorTone: post.authorTone,
    contextLabel: post.contextLabel,
    kind: post.kind,
    category: post.category,
    title: post.title,
    body: post.body,
    reactionCount: post.reactionCount,
    reactionLabel: post.reactionLabel,
    replyCount: post.replyCount,
    replyLabel: post.replyLabel,
    tags: post.tags,
    href: post.href,
    createdAt: post.createdAt.toISOString(),
  };
}
