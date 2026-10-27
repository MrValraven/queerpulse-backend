import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { isPodcastRelease } from './studio-episode-rule';
import { hasUnnotedTrackChanges, isWithheldTrack } from './studio-response';

export type StudioReleaseHealthKey =
  | 'cover'
  | 'description'
  | 'genreAndMood'
  | 'creditsOnEveryTrack'
  | 'lyrics'
  | 'buyLink'
  | 'versionNote';

export interface StudioReleaseHealthItem {
  key: StudioReleaseHealthKey;
  isDone: boolean;
  isOptional: boolean;
}

export type StudioReleaseHealthRelease = Pick<
  StudioRelease,
  | 'status'
  | 'type'
  | 'coverKey'
  | 'description'
  | 'genre'
  | 'mood'
  | 'buyUrl'
  | 'tracksChangedAt'
  | 'publishedAt'
>;

export type StudioReleaseHealthTrack = Pick<
  StudioTrack,
  'credits' | 'lyrics' | 'syncedLyrics' | 'withheldAt'
>;

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function hasLyrics(track: StudioReleaseHealthTrack): boolean {
  return (
    hasText(track.lyrics) ||
    (Array.isArray(track.syncedLyrics) && track.syncedLyrics.length > 0)
  );
}

/**
 * Studio dashboard: the checklist the owner sees on a release row. A taken
 * down release has none, a podcast release asks for a cover and a
 * description, and any other release adds genre and mood, credits, lyrics
 * and a buy link, plus a version note when published tracks changed.
 */
export function toReleaseHealth(
  release: StudioReleaseHealthRelease,
  tracks: StudioReleaseHealthTrack[],
  latestVersionCreatedAt: Date | null,
): StudioReleaseHealthItem[] {
  if (release.status === StudioReleaseStatus.TakenDown) {
    return [];
  }
  const items: StudioReleaseHealthItem[] = [
    { key: 'cover', isDone: hasText(release.coverKey), isOptional: false },
    {
      key: 'description',
      isDone: hasText(release.description),
      isOptional: false,
    },
  ];
  if (isPodcastRelease(release)) {
    return items;
  }
  const countedTracks = tracks.filter((track) => !isWithheldTrack(track));
  const hasCountedTracks = countedTracks.length > 0;
  items.push(
    {
      key: 'genreAndMood',
      isDone: hasText(release.genre) && hasText(release.mood),
      isOptional: false,
    },
    {
      key: 'creditsOnEveryTrack',
      isDone:
        hasCountedTracks &&
        countedTracks.every((track) => (track.credits ?? []).length > 0),
      isOptional: false,
    },
    {
      key: 'lyrics',
      isDone: hasCountedTracks && countedTracks.every(hasLyrics),
      isOptional: true,
    },
    { key: 'buyLink', isDone: hasText(release.buyUrl), isOptional: true },
  );
  if (hasUnnotedTrackChanges(release, latestVersionCreatedAt)) {
    items.push({ key: 'versionNote', isDone: false, isOptional: false });
  }
  return items;
}
