import { TopicPost } from './entities/topic-post.entity';

/**
 * The shape returned by `GET /topics/:slug/posts`. It mirrors the frontend's
 * `TopicPost` interface (`queerpulse/src/features/topics/topics.data.tsx`)
 * field-for-field where that interface is plain data, and flattens the
 * JSX-only fields (`title`, `stats`) to their plain-text/structured
 * equivalents (see `entities/topic-post.entity.ts` for the modeling
 * rationale). `queerpulse/src/features/topics/api/topics.adapters.ts`
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

/**
 * Why a topic post's byline hides the member who wrote its thread. The same
 * two cases `forum-response.ts` swaps its `QUEERPULSE_AUTHOR` and
 * `ANONYMOUS_AUTHOR` bylines in for, and in the same precedence: an official
 * thread reads as the platform's even when it was also posted anonymously.
 */
export type TopicPostAuthorMask = 'official' | 'anonymous';

/** The display fields a masked topic post carries in place of the writer's. */
export interface TopicPostMaskedByline {
  authorName: string;
  authorInitials: string;
  authorTone: string;
}

/**
 * The masked bylines, shared by the write (`TopicPostLinkService.linkThread`)
 * and the read (`maskTopicPostAuthor`) so both spell them identically. The
 * names match `forum-response.ts`'s `QUEERPULSE_AUTHOR.displayName` and
 * `ANONYMOUS_AUTHOR.displayName`, so a thread reads the same on its topic
 * page as it does in the forum.
 */
export const TOPIC_POST_MASKED_BYLINES: Record<
  TopicPostAuthorMask,
  TopicPostMaskedByline
> = {
  official: {
    authorName: 'QueerPulse',
    authorInitials: 'QP',
    authorTone: 'plum',
  },
  anonymous: {
    authorName: 'Anonymous member',
    authorInitials: 'A',
    authorTone: 'plum',
  },
};

/** The mask a thread's two byline flags call for, or null for a plain byline. */
export function topicPostAuthorMaskFor(thread: {
  isAnonymous: boolean;
  isOfficial: boolean;
}): TopicPostAuthorMask | null {
  if (thread.isOfficial) return 'official';
  if (thread.isAnonymous) return 'anonymous';
  return null;
}

/**
 * `response` with its author fields swapped for the masked byline. A null
 * mask returns the response unchanged. Applied on every read, so a row written
 * with the writer's real name before `linkThread` masked at write time is
 * healed on the way out.
 */
export function maskTopicPostAuthor(
  response: TopicPostResponse,
  mask: TopicPostAuthorMask | null,
): TopicPostResponse {
  if (!mask) return response;
  const byline = TOPIC_POST_MASKED_BYLINES[mask];
  return {
    ...response,
    author: byline.authorName,
    authorInitials: byline.authorInitials,
    authorTone: byline.authorTone,
  };
}
