import { NotificationType } from './entities/notification.entity';

/**
 * Collapsing same-subject notification rows on write.
 *
 * The problem: forty replies to one thread wrote forty rows. The bell then
 * reads as forty separate events, the unread badge says forty, and clearing it
 * is forty taps for one conversation. Reading a thread is one act of attention,
 * so it should be one row.
 *
 * The approach is WRITE-time, not read-time, for the same reason the block/mute
 * filter is (see `NotificationsService.create`): the live socket push and the
 * phone push both hang off the write, so anything a read-time grouping did
 * would arrive forty buzzes too late. On write, an unread row for the same
 * (recipient, type, subject) that is still recent absorbs the new one: its
 * payload is replaced with the newest actor's, `otherActorCount` goes up by one,
 * and `createdAt` is bumped so the bundle floats back to the top of the feed.
 *
 * What deliberately does NOT change:
 *  - **Mark as read** still marks one row, which is the whole bundle. That is
 *    correct: you read the thread, not one reply in it.
 *  - **The unread count** counts rows, so a bundle is 1. That is the point.
 *  - **The href** is derived from the payload, and the payload is replaced with
 *    the newest event for the SAME subject, so the link keeps pointing at the
 *    thread it always pointed at (now at its newest reply).
 *
 * Once a row is read, it stops absorbing: the next reply starts a fresh row, so
 * a member who has caught up is told about new activity rather than watching a
 * counter tick on a row they already dismissed.
 */

/**
 * How long an unread row keeps absorbing same-subject events.
 *
 * Twelve hours, chosen so a working day's activity on one thread is one row
 * while yesterday's conversation and today's are still two. Beyond the window a
 * new row is written even though the old one is unread, because "Ana and 39
 * others replied" spanning a week is no longer a summary of anything.
 */
export const NOTIFICATION_BUNDLE_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Column width of `notifications.bundle_key`; keys are truncated to fit. */
export const NOTIFICATION_BUNDLE_KEY_MAX_LENGTH = 200;

/**
 * The subject key a notification of this type collapses on, or `null` when the
 * type does not bundle at all.
 *
 * A type bundles only when repetition genuinely says nothing new: forty replies
 * to one thread, forty posts in one community, forty RSVPs to one gathering.
 * Types where each event is its own fact are absent on purpose, and two
 * absences are load-bearing:
 *  - **`Mention`** never bundles. Being named is directed at you personally,
 *    and "Ana and 3 others mentioned you" hides three separate asks.
 *  - **Every always-delivered type except `AdminQueueItem`** (moderation,
 *    account, governance, decisions) never bundles, because each is a distinct
 *    outcome and there is no shared subject to collapse onto in the first
 *    place: a ban, a decision, a security alert is its own fact, not a
 *    repetition of the last one.
 *
 *    **`AdminQueueItem` is the one exception**, and it is reasoned about
 *    rather than overlooked. Unlike an outcome, a queue IS a shared subject:
 *    twelve invite requests landing in the same queue inside the bundling
 *    window are not twelve distinct facts, they are the same fact, "there are
 *    more", said twelve times. Collapsing them onto the queue is exactly what
 *    bundling exists for, and it costs nothing an outcome type would lose,
 *    because nobody reads "the queue got another item" as a report on any one
 *    item in it.
 *
 * The key must identify the SUBJECT, never the actor: it is what makes two
 * events "the same thing happening again". A type whose payload is missing its
 * subject field returns `null` and simply writes its own row, so a payload shape
 * that changes upstream degrades to the pre-bundling behaviour instead of
 * collapsing rows that are not actually related.
 */
export function bundleKeyFor(
  type: NotificationType,
  payload: Record<string, unknown>,
): string | null {
  const subject = subjectFor(type, payload);
  if (!subject) return null;
  return `${type}:${subject}`.slice(0, NOTIFICATION_BUNDLE_KEY_MAX_LENGTH);
}

function subjectFor(
  type: NotificationType,
  payload: Record<string, unknown>,
): string | null {
  switch (type) {
    // Replies collapse onto the thread or post they are replies to.
    case NotificationType.ForumReply:
    case NotificationType.ForumThreadReply:
      return (
        stringField(payload, 'threadSlug') ?? stringField(payload, 'threadId')
      );
    case NotificationType.CommunityReply:
      return stringField(payload, 'postId') ?? stringField(payload, 'threadId');
    // Posts and resources collapse onto the community they landed in.
    case NotificationType.CommunityNewPost:
    case NotificationType.CommunityResourceAdded:
      return stringField(payload, 'communitySlug');
    // A followed topic's new posts collapse onto the topic.
    case NotificationType.TopicNewPost:
      return (
        stringField(payload, 'topicSlug') ?? stringField(payload, 'topicLabel')
      );
    // "Someone RSVP'd" collapses onto the gathering.
    case NotificationType.EventRsvp:
      return (
        stringField(payload, 'eventSlug') ?? stringField(payload, 'eventId')
      );
    // A new follower collapses onto the persona that was followed.
    case NotificationType.PersonaFollowed:
      return (
        stringField(payload, 'subprofileId') ??
        stringField(payload, 'personaId')
      );
    // An admin queue's arrivals collapse onto the QUEUE.
    //
    // This is the one always-delivered type that bundles, which the docstring
    // above otherwise rules out. The reason that rule holds elsewhere is that
    // an outcome (a ban, a decision, a security alert) has no shared subject
    // to collapse onto: each is its own distinct fact. A queue does have one,
    // and it is the queue itself. A second arrival in the same queue says only
    // "there are more", which is exactly what a bundle is for. Twelve invite
    // requests then read as one row rather than twelve, and once the row is
    // read the next arrival opens a fresh one.
    case NotificationType.AdminQueueItem:
      return stringField(payload, 'queue');
    default:
      return null;
  }
}

/** A non-empty string field from a notification payload, or `null`. */
function stringField(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
