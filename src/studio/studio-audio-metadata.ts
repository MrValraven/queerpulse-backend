import type { Readable } from 'node:stream';
import type { StudioAudioContentType } from './studio.constants';

/**
 * The only file in this repo that loads `music-metadata`.
 *
 * The package is ESM-only and this repo compiles to CommonJS, so it is
 * loaded through a dynamic `import()`, which `module: nodenext` keeps as a
 * real `import()` in the emitted CommonJS. It loads once and is reused.
 * Specs never reach the package: they test `classifyStudioAudio` directly
 * and mock `readStudioAudioFactsWithin`.
 */

/** How long one confirm may spend reading a stored track. */
export const STUDIO_AUDIO_PARSE_TIMEOUT_MILLISECONDS = 60_000;

/** The facts `music-metadata` reports that decide whether a file is usable. */
export interface StudioAudioFormatFacts {
  container: string | undefined;
  codec: string | undefined;
  duration: number | undefined;
  sampleRate: number | undefined;
  hasVideoTrack: boolean;
}

export type StudioAudioVerdict =
  { isReadable: true; durationSeconds: number } | { isReadable: false };

type MusicMetadataModule = typeof import('music-metadata');

let musicMetadataModule: Promise<MusicMetadataModule> | null = null;

function loadMusicMetadata(): Promise<MusicMetadataModule> {
  musicMetadataModule ??= import('music-metadata');
  return musicMetadataModule;
}

/**
 * Whether the parsed facts describe the audio the content type promised.
 * MP3 is MPEG Layer 3 in an MPEG container; M4A is AAC with no video track.
 */
export function classifyStudioAudio(
  facts: StudioAudioFormatFacts,
  declaredContentType: StudioAudioContentType,
): StudioAudioVerdict {
  const { duration, sampleRate } = facts;
  if (
    duration === undefined ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    sampleRate === undefined ||
    sampleRate <= 0
  ) {
    return { isReadable: false };
  }
  const codec = facts.codec ?? '';
  const isMatchingFormat =
    declaredContentType === 'audio/mpeg'
      ? facts.container === 'MPEG' && /Layer 3/.test(codec)
      : facts.container !== undefined &&
        /AAC/i.test(codec) &&
        !facts.hasVideoTrack;
  if (!isMatchingFormat) {
    return { isReadable: false };
  }
  return {
    isReadable: true,
    durationSeconds: Math.max(1, Math.round(duration)),
  };
}

/**
 * Parses a stored object's stream with `music-metadata`, sniffing the format
 * from the bytes (no MIME hint, so a renamed file cannot steer the parser).
 * Rejects when the read takes longer than `timeoutMilliseconds`. The caller
 * owns the stream and destroys it either way.
 */
export async function readStudioAudioFactsWithin(
  stream: Readable,
  byteSize: number,
  timeoutMilliseconds: number,
): Promise<StudioAudioFormatFacts> {
  const { parseStream } = await loadMusicMetadata();
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('Reading the audio file timed out')),
      timeoutMilliseconds,
    );
  });
  try {
    const metadata = await Promise.race([
      parseStream(
        stream,
        { size: byteSize },
        {
          duration: true,
          skipCovers: true,
        },
      ),
      timeout,
    ]);
    const format = metadata.format;
    return {
      container: format.container,
      codec: format.codec,
      duration: format.duration,
      sampleRate: format.sampleRate,
      hasVideoTrack: format.trackInfo.some(
        (track) => track.video !== undefined,
      ),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
