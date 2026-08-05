import { toImageUrl } from '../../common/image-url';
import { Notification } from '../../notifications/entities/notification.entity';
import { Profile } from '../../users/entities/profile.entity';

/**
 * The member who wrote the `@`-mention, resolved for display so the inbox can
 * name and link to them (and show their avatar). `null` when the row carries no
 * `actorId` or the actor's profile can no longer be resolved — the row still
 * renders through its generic copy.
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
  /** The mention text (the post/reply body, truncated at write time). */
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
          slug: actorProfile.slug,
          firstName: actorProfile.firstName,
          lastName: actorProfile.lastName,
          avatarUrl: toImageUrl(actorProfile.avatarUrl),
        }
      : null,
    source,
    entityKind: stringOrNull(payload, 'entityKind'),
    excerpt: stringOrNull(payload, 'excerpt') ?? '',
    threadSlug,
    communitySlug,
    postId: stringOrNull(payload, 'postId'),
    sourceLabel,
  };
}
