import { LessThan, Repository } from 'typeorm';
import { StudioRelease } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { hasPlayableAudio, isWithheldTrack } from './studio-response';

/** The track columns the gapless lookup reads. */
export type StudioGaplessCandidate = Pick<
  StudioTrack,
  'id' | 'position' | 'audioKey' | 'durationSeconds' | 'withheldAt'
>;

/**
 * Studio listening: the track a gapless release plays straight into the
 * given one. `earlierTracks` come nearest first (position DESC); the first
 * with playable audio that is not withheld wins, which matches the
 * frontend's `queueFromRelease` skipping tracks without audio. Null when
 * no earlier track plays.
 */
export function previousPlayableTrackId(
  earlierTracks: readonly StudioGaplessCandidate[],
): string | null {
  const previousTrack = earlierTracks.find(
    (track) => hasPlayableAudio(track) && !isWithheldTrack(track),
  );
  return previousTrack?.id ?? null;
}

/**
 * Studio listening: `StudioStream.gaplessAfterTrackId`. A release that is
 * not gapless answers null without a query; a gapless one reads the earlier
 * tracks of the release and picks the nearest playable one.
 */
export async function findGaplessAfterTrackId(
  tracks: Repository<StudioTrack>,
  release: Pick<StudioRelease, 'id' | 'isGapless'>,
  track: Pick<StudioTrack, 'position'>,
): Promise<string | null> {
  if (!release.isGapless) {
    return null;
  }
  const earlierTracks = await tracks.find({
    where: { releaseId: release.id, position: LessThan(track.position) },
    select: {
      id: true,
      position: true,
      audioKey: true,
      durationSeconds: true,
      withheldAt: true,
    },
    order: { position: 'DESC' },
  });
  return previousPlayableTrackId(earlierTracks);
}
