export const FORUM_THREAD_CREATED = 'forum.thread_created';

/**
 * A member started a new forum thread. Emitted once, after the thread (and its
 * OP post) have committed, so a listener never reacts to a thread a rolled-back
 * transaction never created. The forum is a members-wide public square — every
 * thread is readable by every active member — so this carries no visibility
 * gate: unlike a community post, there is no private variant to filter on.
 *
 * Consumed by the profiles `ActivityListener`, which records a public
 * "started a thread" activity row for the author's profile.
 */
export interface ForumThreadCreatedEvent {
  authorId: string;
  threadSlug: string;
  title: string;
}
