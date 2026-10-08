import { DataSource, In, IsNull } from 'typeorm';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { Event, EventStatus } from '../events/entities/event.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Message } from '../messaging/entities/message.entity';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import {
  MentionLiveEvent,
  MentionSourceContext,
  MentionSourceRepositories,
  mentionIdsWithStaleExcerpt,
} from './mention-source-freshness';

/** Thread review states a member can read (`reviewState` docstring). */
export const READABLE_REVIEW_STATES: ReadonlySet<string | null> = new Set([
  null,
  'approved',
]);

/** Whether a member can read a standing thread in this review state. */
export function isReadableThread(
  thread: Pick<ForumThread, 'reviewState'>,
): boolean {
  return READABLE_REVIEW_STATES.has(thread.reviewState);
}

/** The thread fields the freshness check reads. */
export type MentionThreadRow = Pick<ForumThread, 'id' | 'slug' | 'reviewState'>;

/**
 * The community fields the freshness check reads. A caller passing its own
 * rows as `loaded` must select `parentId`: a row read without it looks like
 * a top-level community, so its parent is never checked.
 */
export type MentionCommunityRow = Pick<
  Community,
  'slug' | 'archivedAt' | 'parentId'
>;

/** The fields of a space's parent community the freshness check reads. */
export type MentionParentCommunityRow = Pick<
  Community,
  'id' | 'slug' | 'archivedAt'
>;

/** The gathering fields the freshness check reads. */
export type MentionEventRow = Pick<Event, 'id' | 'slug' | 'description'>;

/** Threads and communities the rows name, when the caller already read them. */
export interface LoadedMentionSources {
  threads: MentionThreadRow[];
  communities: MentionCommunityRow[];
  /** The published gatherings the rows name, when the caller already read
   *  them; a gathering left out reads as gone. Absent, each batch reads its
   *  own through `loadLiveMentionEvents`. */
  events?: MentionEventRow[];
}

/**
 * Mention rows checked per round. The data export reads every row a member
 * holds, so its ids go out in slices that keep each `IN` list well inside
 * Postgres' bind-parameter limit. An inbox page (20 rows) is one round.
 */
const STALE_EXCERPT_BATCH_SIZE = 500;

/** Distinct, defined string values of one payload key across the rows. */
export function collectPayloadStrings(
  rows: Notification[],
  key: string,
): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.payload?.[key])
        .filter(
          (value): value is string => typeof value === 'string' && !!value,
        ),
    ),
  ];
}

/**
 * The per-page context `mentionIdsWithStaleExcerpt` reads. A space's parent
 * gates it the way `CommunitiesService.assertParentViewable` and the shared
 * `assertCommunityInteriorReadable` (`communities/community-read-gate.ts`)
 * do: a parent that is archived, or absent from `parentCommunities` (so it could not be
 * loaded), makes the space read as gone, and a present parent's slug is
 * handed on for the takedown lookup.
 */
export function mentionSourceContextOf(
  sources: LoadedMentionSources,
  parentCommunities: MentionParentCommunityRow[],
): MentionSourceContext {
  const parentById = new Map(
    parentCommunities.map((parent) => [parent.id, parent]),
  );
  const parentSlugBySpaceSlug = new Map<string, string>();
  const spaceSlugsWithUnviewableParent = new Set<string>();
  for (const community of sources.communities) {
    if (!community.parentId) continue;
    const parent = parentById.get(community.parentId);
    if (!parent || parent.archivedAt) {
      spaceSlugsWithUnviewableParent.add(community.slug);
    } else {
      parentSlugBySpaceSlug.set(community.slug, parent.slug);
    }
  }
  return {
    readableThreadIdBySlug: new Map(
      sources.threads
        .filter(isReadableThread)
        .map((thread) => [thread.slug, thread.id]),
    ),
    archivedCommunitySlugs: new Set(
      sources.communities
        .filter((community) => !!community.archivedAt)
        .map((community) => community.slug),
    ),
    parentSlugBySpaceSlug,
    spaceSlugsWithUnviewableParent,
  };
}

/**
 * The parents of the spaces among `communities`, in one query, and no query
 * when none of them is a space. A parent missing from the result could not
 * be loaded, which `mentionSourceContextOf` reads as unviewable.
 */
async function loadSpaceParents(
  communities: MentionCommunityRow[],
  dataSource: DataSource,
): Promise<MentionParentCommunityRow[]> {
  const parentIds = [
    ...new Set(
      communities
        .map((community) => community.parentId)
        .filter(
          (parentId): parentId is string =>
            typeof parentId === 'string' && !!parentId,
        ),
    ),
  ];
  if (!parentIds.length) return [];
  return dataSource.getRepository(Community).find({
    where: { id: In(parentIds) },
    select: { id: true, slug: true, archivedAt: true },
  });
}

/**
 * The PUBLISHED gatherings the `event` mention rows among `rows` name, in one
 * query, and no query when none of them is an `event` mention. A draft or
 * cancelled gathering stays out, so its mention reads as gone.
 */
export async function loadLiveMentionEvents(
  rows: Notification[],
  dataSource: DataSource,
): Promise<MentionEventRow[]> {
  const eventSlugs = collectPayloadStrings(
    rows.filter((row) => row.payload?.source === 'event'),
    'eventSlug',
  );
  if (!eventSlugs.length) return [];
  return dataSource.getRepository(Event).find({
    where: { slug: In(eventSlugs), status: EventStatus.Published },
    select: { id: true, slug: true, description: true },
  });
}

/** The `liveEventBySlug` context entry for a set of published gatherings. */
function liveEventBySlugOf(
  events: MentionEventRow[],
): Map<string, MentionLiveEvent> {
  return new Map(
    events.map((event) => [
      event.slug,
      { id: event.id, description: event.description },
    ]),
  );
}

/** The context for one batch: its sources plus the parents of its spaces. */
async function batchContextOf(
  sources: LoadedMentionSources,
  dataSource: DataSource,
): Promise<MentionSourceContext> {
  return mentionSourceContextOf(
    sources,
    await loadSpaceParents(sources.communities, dataSource),
  );
}

function sourceRepositoriesOf(
  dataSource: DataSource,
): MentionSourceRepositories {
  return {
    forumPosts: dataSource.getRepository(ForumPost),
    communityPosts: dataSource.getRepository(CommunityPost),
    communityReplies: dataSource.getRepository(CommunityPostReply),
    messages: dataSource.getRepository(Message),
    contentModeration: dataSource.getRepository(ContentModeration),
  };
}

/**
 * The threads and communities a batch of mention rows names, read with the
 * same filters the inbox applies: a withdrawn thread never resolves, and a
 * community carries its `archivedAt` and, for a space, its `parentId`.
 */
async function loadMentionSources(
  rows: Notification[],
  dataSource: DataSource,
): Promise<LoadedMentionSources> {
  const threadSlugs = collectPayloadStrings(rows, 'threadSlug');
  const communitySlugs = collectPayloadStrings(rows, 'communitySlug');
  const [threads, communities] = await Promise.all([
    threadSlugs.length
      ? dataSource.getRepository(ForumThread).find({
          where: { slug: In(threadSlugs), deletedAt: IsNull() },
          select: { id: true, slug: true, reviewState: true },
        })
      : Promise.resolve([] as ForumThread[]),
    communitySlugs.length
      ? dataSource.getRepository(Community).find({
          where: { slug: In(communitySlugs) },
          select: { slug: true, archivedAt: true, parentId: true },
        })
      : Promise.resolve([] as Community[]),
  ]);
  return { threads, communities };
}

/**
 * ENG-411: the ids of the mention rows whose frozen `excerpt` must be blanked
 * wherever the row is served, the mentions inbox and the data export alike.
 * The rules live in `mentionIdsWithStaleExcerpt`: the source is deleted,
 * deleted for everyone, edited after the mention, taken down (by a community
 * moderator's tombstone or a platform moderator's hide or removal), in an
 * archived or taken-down community (or a space whose parent is archived,
 * taken down or gone), or in a thread a member can no longer read. An
 * `event` mention reads as gone once its gathering is no longer published,
 * is taken down, or its description no longer begins with the excerpt.
 *
 * Rows of any other type are ignored. The rows are checked in batches, each
 * batch costing one query per source kind it contains, plus one for the
 * parents of its spaces when it names any. A caller that already read the
 * rows' threads and communities (the inbox, for its labels) passes them as
 * `loaded` and has their parents read once for the whole call; otherwise
 * each batch reads its own through `dataSource`.
 */
export async function staleMentionExcerptIds(
  rows: Notification[],
  dataSource: DataSource,
  loaded?: LoadedMentionSources,
): Promise<Set<string>> {
  const mentionRows = rows.filter(
    (row) => row.type === NotificationType.Mention,
  );
  const repositories = sourceRepositoriesOf(dataSource);
  const staleIds = new Set<string>();
  let loadedContext: MentionSourceContext | undefined;
  for (
    let start = 0;
    start < mentionRows.length;
    start += STALE_EXCERPT_BATCH_SIZE
  ) {
    const batch = mentionRows.slice(start, start + STALE_EXCERPT_BATCH_SIZE);
    let context: MentionSourceContext;
    if (loaded) {
      if (!loadedContext) {
        loadedContext = await batchContextOf(loaded, dataSource);
      }
      context = loadedContext;
    } else {
      context = await batchContextOf(
        await loadMentionSources(batch, dataSource),
        dataSource,
      );
    }
    const liveEvents =
      loaded?.events ?? (await loadLiveMentionEvents(batch, dataSource));
    const batchStaleIds = await mentionIdsWithStaleExcerpt(
      batch,
      { ...context, liveEventBySlug: liveEventBySlugOf(liveEvents) },
      repositories,
    );
    for (const id of batchStaleIds) staleIds.add(id);
  }
  return staleIds;
}
