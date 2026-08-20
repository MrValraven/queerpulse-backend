export const TOPIC_POST_LINKED = 'topic.post_linked';

/**
 * Fired once per `topic_post` row `TopicPostLinkService.linkThread` creates —
 * one event per (topic, thread) pair, since each topic has its own distinct
 * follower list to fan out to (`topic_follows`, `TopicFollowNotificationsListener`
 * in the topics module). A thread tagged with several matching topics fires
 * this once per topic, not once per thread.
 */
export interface TopicPostLinkedEvent {
  topicId: string;
  topicSlug: string;
  topicLabel: string;
  postId: string;
  threadSlug: string;
  threadTitle: string;
  /** The thread's author — the acting member for block/mute + display. */
  authorId: string;
}
