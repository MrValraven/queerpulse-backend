import { BadRequestException } from '@nestjs/common';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioSource } from './entities/studio-track.entity';
import { isPodcastRelease } from './studio-episode-rule';
import {
  StudioFormat,
  isSourceRequiredReleaseType,
  studioError,
  studioLyricsMaxLengthFor,
} from './studio.constants';

/*
 * Studio artist kinds: what a track write accepts beside the v1 and
 * Listening fields. The PATCH body validates shapes; these rules need the
 * release and the persona's format, read under the release lock.
 */

/** The body allows 60000 characters; a podcast or spoken word transcript
 *  keeps them, every other format stops at 10000. Answers in the shape the
 *  `ValidationPipe` uses for the same field. */
export function assertLyricsWithinFormat(
  lyrics: string | null,
  format: StudioFormat | null,
): void {
  const maxLength = studioLyricsMaxLengthFor(format);
  if (lyrics !== null && lyrics.length > maxLength) {
    throw new BadRequestException([
      `lyrics must be shorter than or equal to ${maxLength} characters`,
    ]);
  }
}

/** Show notes keep their own line breaks; blank notes are stored as none,
 *  and only an episode stores any. */
export function notesForTrack(
  notes: string | null,
  release: Partial<Pick<StudioRelease, 'type'>>,
): string | null {
  const storedNotes = notes && notes.trim() ? notes : null;
  if (storedNotes !== null && !isPodcastRelease(release)) {
    throw studioError('studio_not_a_podcast');
  }
  return storedNotes;
}

/** Sources belong to edits, lip-sync mixes and mixes. A release that is
 *  out or scheduled keeps the credit its publish required, as it keeps its
 *  cover. */
export function sourcesForTrack(
  sources: readonly StudioSource[],
  release: Pick<StudioRelease, 'status'> & Partial<Pick<StudioRelease, 'type'>>,
): StudioSource[] {
  const isSourceType =
    release.type !== undefined && isSourceRequiredReleaseType(release.type);
  if (!isSourceType) {
    if (sources.length > 0) {
      throw new BadRequestException([
        'sources are for edit, lip-sync and mix tracks',
      ]);
    }
    return [];
  }
  const isLiveOrUpcoming =
    release.status === StudioReleaseStatus.Published ||
    release.status === StudioReleaseStatus.Scheduled;
  if (sources.length === 0 && isLiveOrUpcoming) {
    throw studioError('studio_publish_missing_sources');
  }
  return sources.map(({ title, artist }) => ({ title, artist }));
}

/** The publish rule's sources check: every track credits one or more. */
export function hasEverySource(
  tracks: readonly { sources: readonly StudioSource[] }[],
): boolean {
  return tracks.every((track) => track.sources.length > 0);
}
