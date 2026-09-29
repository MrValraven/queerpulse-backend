import { toImageUrl } from '../../common/image-url';
import { Notification } from '../../notifications/entities/notification.entity';
import { Profile } from '../../users/entities/profile.entity';

/**
 * The member who wrote the `@`-mention, resolved for display so the inbox can
 * name and link to them (and show their avatar). Inside a Go together chat
 * (PRD-423) `lastName` and `slug` are empty strings: first name only, no
 * profile link. `null` when the row carries no `actorId` or the actor's
 * profile can no longer be resolved: the row still renders through its
 * generic copy.
 */
export interface MentionActor {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

/**
 * A single `@`-mention as served to the inbox. Built by hand from a
 * `NotificationType.Mention` row (there is no separate mentions table — mentions
 * are persisted only as notifications; see `MentionNotificationService`), so
 * this DTO flattens the row's opaque `payload` into the fields the frontend
 * needs and drops everything else. No entity is ever returned raw (repo
 * API-response-mapping convention).
 *
 * `sourceLabel` is the human name of *where* the mention happened — the forum
 * thread's title or the community's name — resolved server-side so the client
 * doesn't have to guess it from a slug. `threadSlug`/`communitySlug`/`postId`
 * are handed through so the client can build the deep-link with its own router
 * map (routing stays a frontend concern).
 */
export interface MentionResponse {
  /** The backing notification id — also the id the client marks read via
   *  `POST /notifications/:id/read`. */
  id: string;
  createdAt: Date;
  read: boolean;
  actor: MentionActor | null;
  /** Where the mention was written: `'forum'` | `'community'` | `null`. */
  source: string | null;
  /** What was `@`-tagged: `member` | `community` | `business` | `event` |
   *  `thread` | `null`. */
  entityKind: string | null;
  /** The mention text (the post/reply body, truncated at write time). An
   *  empty string when the source is gone or was edited after the mention
   *  (ENG-411, `mentionIdsWithStaleExcerpt`), so words the author deleted,
   *  changed or had taken down are never served from this copy. */
  excerpt: string;
  threadSlug: string | null;
  communitySlug: string | null;
  postId: string | null;
  /** Resolved title/name of the source thread or community; `null` when it
   *  could not be resolved (deleted, or no slug in the payload). */
  sourceLabel: string | null;
}

/** Reads a string field from an opaque jsonb payload, or `null`. */
function stringOrNull(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value ? value : null;
}

export interface MentionResolvers {
  profileByUserId: Map<string, Profile>;
  threadTitleBySlug: Map<string, string>;
  communityNameBySlug: Map<string, string>;
  /** Ids of the page's rows whose excerpt must not be served (ENG-411). */
  staleExcerptNotificationIds: Set<string>;
}

export function toMentionResponse(
  notification: Notification,
  resolvers: MentionResolvers,
): MentionResponse {
  const payload = notification.payload;
  const actorId = stringOrNull(payload, 'actorId');
  const actorProfile = actorId
    ? resolvers.profileByUserId.get(actorId)
    : undefined;
  const source = stringOrNull(payload, 'source');
  // PRD-423: a mention written inside a Go together chat names the mentioner
  // the way the chat does, by first name alone, with an empty `slug` so the
  // inbox links to no profile. `MessagesService` writes this payload key.
  const isGoTogetherChatMention =
    source === 'message' && payload?.isGoTogetherChat === true;
  const threadSlug = stringOrNull(payload, 'threadSlug');
  const communitySlug = stringOrNull(payload, 'communitySlug');

  const sourceLabel =
    source === 'forum' && threadSlug
      ? (resolvers.threadTitleBySlug.get(threadSlug) ?? null)
      : source === 'community' && communitySlug
        ? (resolvers.communityNameBySlug.get(communitySlug) ?? null)
        : null;

  return {
    id: notification.id,
    createdAt: notification.createdAt,
    read: notification.read,
    actor: actorProfile
      ? {
          slug: isGoTogetherChatMention ? '' : actorProfile.slug,
          firstName: isGoTogetherChatMention
            ? actorProfile.firstName.trim()
            : actorProfile.firstName,
          lastName: isGoTogetherChatMention ? '' : actorProfile.lastName,
          // ENG-412: an actor who hid their photo shows no avatar here, the
          // same `photoVisible` gate the bell applies. Name and link stay.
          avatarUrl: actorProfile.photoVisible
            ? toImageUrl(actorProfile.avatarUrl)
            : null,
        }
      : null,
    source,
    entityKind: stringOrNull(payload, 'entityKind'),
    excerpt: resolvers.staleExcerptNotificationIds.has(notification.id)
      ? ''
      : (stringOrNull(payload, 'excerpt') ?? ''),
    threadSlug,
    communitySlug,
    postId: stringOrNull(payload, 'postId'),
    sourceLabel,
  };
}
