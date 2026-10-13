import {
  StudioAudioFormatFacts,
  classifyStudioAudio,
} from './studio-audio-metadata';

const mp3Facts = (
  overrides: Partial<StudioAudioFormatFacts> = {},
): StudioAudioFormatFacts => ({
  container: 'MPEG',
  codec: 'MPEG 1 Layer 3',
  duration: 241.6,
  sampleRate: 44100,
  hasVideoTrack: false,
  ...overrides,
});

const m4aFacts = (
  overrides: Partial<StudioAudioFormatFacts> = {},
): StudioAudioFormatFacts => ({
  container: 'M4A/mp42/isom',
  codec: 'MPEG-4/AAC',
  duration: 180.2,
  sampleRate: 48000,
  hasVideoTrack: false,
  ...overrides,
});

describe('classifyStudioAudio', () => {
  it('reads an MP3 and rounds its duration to whole seconds', () => {
    expect(classifyStudioAudio(mp3Facts(), 'audio/mpeg')).toEqual({
      isReadable: true,
      durationSeconds: 242,
    });
  });

  it('reads an AAC M4A', () => {
    expect(classifyStudioAudio(m4aFacts(), 'audio/mp4')).toEqual({
      isReadable: true,
      durationSeconds: 180,
    });
  });

  it('counts a clip shorter than half a second as one second', () => {
    expect(
      classifyStudioAudio(mp3Facts({ duration: 0.3 }), 'audio/mpeg'),
    ).toEqual({ isReadable: true, durationSeconds: 1 });
  });

  it('refuses an MP3 claim whose container is not MPEG audio', () => {
    expect(
      classifyStudioAudio(
        mp3Facts({ container: 'ADTS/MPEG-4', codec: 'AAC' }),
        'audio/mpeg',
      ),
    ).toEqual({ isReadable: false });
    expect(
      classifyStudioAudio(
        mp3Facts({ container: undefined, codec: undefined }),
        'audio/mpeg',
      ),
    ).toEqual({ isReadable: false });
  });

  it('refuses an M4A holding a codec other than AAC', () => {
    expect(
      classifyStudioAudio(m4aFacts({ codec: 'ALAC' }), 'audio/mp4'),
    ).toEqual({ isReadable: false });
  });

  it('refuses an MP4 that carries a video track', () => {
    expect(
      classifyStudioAudio(m4aFacts({ hasVideoTrack: true }), 'audio/mp4'),
    ).toEqual({ isReadable: false });
  });

  it.each([undefined, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a duration of %p',
    (duration) => {
      expect(classifyStudioAudio(mp3Facts({ duration }), 'audio/mpeg')).toEqual(
        { isReadable: false },
      );
    },
  );

  it('refuses audio with no sample rate', () => {
    expect(
      classifyStudioAudio(mp3Facts({ sampleRate: undefined }), 'audio/mpeg'),
    ).toEqual({ isReadable: false });
  });
});
