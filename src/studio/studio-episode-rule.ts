import { EntityManager } from 'typeorm';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { STUDIO_LIMITS, studioError } from './studio.constants';

/*
 * Studio artist kinds: the podcast rules
 * (QUEERPULSE-STUDIO-ARTIST-KINDS-DESIGN-2026-10-14.md section 4). A show is
 * a release of type `podcast` and each episode is one of its tracks. An
 * episode reaches listeners once its `published_at` has come; a track of
 * any other type follows its release as before. This module imports
 * entities and constants only, so `studio-response.ts` and
 * `studio-playlist-visibility.ts` both read it without an import cycle.
 */

export function isPodcastRelease(
  release: Partial<Pick<StudioRelease, 'type'>>,
): boolean {
  return release.type === StudioReleaseType.Podcast;
}

/**
 * The episode arm of the shared playable-track predicate: a track of
 * another type passes, an episode passes once it has a publish time that
 * has come. Parenthesised, so it sits in any AND list.
 */
export function episodeReleasedSql(
  trackAlias: string,
  releaseAlias: string,
): string {
  const track = `"${trackAlias}"`;
  const release = `"${releaseAlias}"`;
  return `(${release}."type" <> '${StudioReleaseType.Podcast}'
    OR (${track}."published_at" IS NOT NULL AND ${track}."published_at" <= now()))`;
}

/** The same arm in TypeScript, for rows already read. */
export function isTrackReleasedToListeners(
  track: Partial<Pick<StudioTrack, 'publishedAt'>>,
  release: Partial<Pick<StudioRelease, 'type'>>,
  now: Date = new Date(),
): boolean {
  if (!isPodcastRelease(release)) {
    return true;
  }
  const publishedAt = track.publishedAt ?? null;
  return publishedAt !== null && publishedAt.getTime() <= now.getTime();
}

/** An episode its owners have not published yet. */
export function isDraftEpisode(
  track: Partial<Pick<StudioTrack, 'publishedAt'>>,
  release: Partial<Pick<StudioRelease, 'type'>>,
): boolean {
  return isPodcastRelease(release) && (track.publishedAt ?? null) === null;
}

/** Oldest episode first; a show publish stamps several episodes with one
 *  time, so stored position breaks the tie. An unstamped one sorts last. */
export function byEpisodeOrder(
  leftTrack: Pick<StudioTrack, 'position'> &
    Partial<Pick<StudioTrack, 'publishedAt'>>,
  rightTrack: Pick<StudioTrack, 'position'> &
    Partial<Pick<StudioTrack, 'publishedAt'>>,
): number {
  const leftTime = leftTrack.publishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightTime =
    rightTrack.publishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return leftTime - rightTime || leftTrack.position - rightTrack.position;
}

/**
 * A show publish stamps every episode that has confirmed audio and no
 * publish time with `$2`, and claims its alert in the same statement: the
 * show's release alert covers these episodes, so the episode alert finds
 * nothing to send. An episode stamped before (a show published, unpublished
 * and published again) keeps its first time. `$1` the release id.
 */
export const STAMP_SHOW_EPISODES_SQL = `UPDATE "studio_tracks"
   SET "published_at" = $2,
       "followers_notified_at" = now()
 WHERE "release_id" = $1
   AND "published_at" IS NULL
   AND "audio_key" IS NOT NULL
   AND "duration_seconds" IS NOT NULL
   AND EXISTS (SELECT 1 FROM "studio_releases" "stamped_release"
                WHERE "stamped_release"."id" = $1
                  AND "stamped_release"."type" = '${StudioReleaseType.Podcast}')`;

/** Runs the stamp inside the caller's publish transaction, for a podcast
 *  show only. */
export async function stampShowEpisodes(
  manager: EntityManager,
  release: Pick<StudioRelease, 'id'> & Partial<Pick<StudioRelease, 'type'>>,
  publishedAt: Date,
): Promise<void> {
  if (!isPodcastRelease(release)) {
    return;
  }
  await manager.query(STAMP_SHOW_EPISODES_SQL, [release.id, publishedAt]);
}

/** `POST /studio/tracks/:id/publish`, checked under the release lock in
 *  this order. The audio check is `hasPlayableAudio` spelled out, which
 *  keeps this module below `studio-response.ts` in the import graph. */
export function assertEpisodePublishable(
  release: Pick<StudioRelease, 'status'> & Partial<Pick<StudioRelease, 'type'>>,
  track: Pick<StudioTrack, 'publishedAt' | 'audioKey' | 'durationSeconds'>,
): void {
  if (!isPodcastRelease(release)) {
    throw studioError('studio_not_a_podcast');
  }
  if (release.status !== StudioReleaseStatus.Published) {
    throw studioError('studio_episode_show_not_published');
  }
  if (track.publishedAt !== null) {
    throw studioError('studio_episode_already_published');
  }
  if (track.audioKey === null || track.durationSeconds === null) {
    throw studioError('studio_publish_tracks_pending');
  }
}

/** Listeners read a published show by publish time, so its stored order is
 *  closed; a draft or scheduled show reorders freely. */
export function assertTrackOrderUnlocked(
  release: Pick<StudioRelease, 'status'> & Partial<Pick<StudioRelease, 'type'>>,
): void {
  if (
    isPodcastRelease(release) &&
    release.status === StudioReleaseStatus.Published
  ) {
    throw studioError('studio_episode_order_locked');
  }
}

const CHAPTER_LINE_PATTERN = /^\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s|[-:.)|]|$)/;

/** The two-line excerpt on an episode row: chapter lines (those starting with
 *  a timestamp) dropped, the first remaining paragraph taken, whitespace
 *  collapsed, cut on the last space at or before 200 characters (a hard cut
 *  when there is none), with an ellipsis when anything was cut. */
export function toNotesExcerpt(
  notes: string | null | undefined,
): string | null {
  const proseLines = (notes ?? '')
    .split(/\r?\n/)
    .filter((line) => !CHAPTER_LINE_PATTERN.test(line));
  const firstParagraph =
    proseLines
      .join('\n')
      .trim()
      .split(/\n\s*\n/)[0] ?? '';
  const collapsed = firstParagraph.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return null;
  }
  const maxLength = STUDIO_LIMITS.notesExcerptMaxLength;
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  const window = collapsed.slice(0, maxLength + 1);
  const lastSpace = window.lastIndexOf(' ');
  const kept =
    lastSpace > 0 ? window.slice(0, lastSpace) : collapsed.slice(0, maxLength);
  return `${kept.trimEnd()}…`;
}
