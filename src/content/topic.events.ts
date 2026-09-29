export const TOPIC_POST_LINKED = 'topic.post_linked';

/**
 * Fired once per `topic_post` row `TopicPostLinkService.linkThread` creates:
 * one event per (topic, thread) pair, since each topic has its own distinct
 * follower list to fan out to (`topic_follows`, `TopicFollowNotificationsListener`
 * in the topics module). A thread tagged with several matching topics fires
 * this once for each of them.
 */
export interface TopicPostLinkedEvent {
  topicId: string;
  topicSlug: string;
  topicLabel: string;
  postId: string;
  threadSlug: string;
  threadTitle: string;
  /** The thread's real author. Listeners use it for block/mute filtering and
   *  to skip the author's own follow; whether it may also be shown as the
   *  acting member is `isAuthorMasked`'s call. NULL when the author erased
   *  their account (ENG-494): there is then nobody to filter against and no
   *  actor to show. */
  authorId: string | null;
  /**
   * True when the thread's byline hides its writer: an anonymous thread, or
   * an official thread posted under the QueerPulse byline. A listener must
   * then keep `authorId` out of anything a recipient can see (a notification
   * `actorId`, a name, an avatar) and use it for block/mute filtering only.
   */
  isAuthorMasked: boolean;
}
