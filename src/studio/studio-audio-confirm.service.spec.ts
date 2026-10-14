import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioAudioConfirmService } from './studio-audio-confirm.service';
import { readStudioAudioFactsWithin } from './studio-audio-metadata';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { STAMP_TRACKS_CHANGED_SQL } from './studio-release-edit-rule';

jest.mock('./studio-audio-metadata', () => ({
  ...jest.requireActual<typeof import('./studio-audio-metadata')>(
    './studio-audio-metadata',
  ),
  readStudioAudioFactsWithin: jest.fn(),
}));

const readFacts = readStudioAudioFactsWithin as jest.MockedFunction<
  typeof readStudioAudioFactsWithin
>;

const USER_ID = 'e3000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'e3000000-0000-4000-8000-000000000002';
const RELEASE_ID = 'e3000000-0000-4000-8000-000000000003';
const TRACK_ID = 'e3000000-0000-4000-8000-000000000004';
const KEY =
  'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';
const OLD_KEY =
  'studio-audio/11111111-2222-4333-8444-555555555555/77777777-7777-4888-9999-000000000000.mp3';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

describe('StudioAudioConfirmService', () => {
  let storedTrack: Partial<StudioTrack>;
  let lockedTrack: Partial<StudioTrack>;
  let tracks: { findOne: jest.Mock; exists: jest.Mock };
  let manager: { findOne: jest.Mock; save: jest.Mock; query: jest.Mock };
  let ownership: {
    loadReleaseForWrite: jest.Mock;
    lockReleaseForWrite: jest.Mock;
  };
  let studioAudioUploads: {
    findRegistration: jest.Mock;
    deleteObjectsAndForget: jest.Mock;
  };
  let storage: { headObject: jest.Mock; openObjectStream: jest.Mock };
  let stream: { destroy: jest.Mock };
  let catalog: { getTrack: jest.Mock };
  let service: StudioAudioConfirmService;

  const writable = (status = StudioReleaseStatus.Draft) => ({
    release: { id: RELEASE_ID, subprofileId: PERSONA_ID, status },
    persona: { id: PERSONA_ID, kind: 'musician' },
  });

  beforeEach(() => {
    storedTrack = { id: TRACK_ID, releaseId: RELEASE_ID, audioKey: null };
    lockedTrack = { id: TRACK_ID, releaseId: RELEASE_ID, audioKey: null };
    tracks = {
      findOne: jest.fn(() => Promise.resolve(storedTrack)),
      exists: jest.fn().mockResolvedValue(false),
    };
    manager = {
      findOne: jest.fn(() => Promise.resolve(lockedTrack)),
      save: jest.fn((row: object) => Promise.resolve(row)),
      query: jest.fn().mockResolvedValue(undefined),
    };
    ownership = {
      loadReleaseForWrite: jest.fn().mockResolvedValue(writable()),
      lockReleaseForWrite: jest.fn().mockResolvedValue(writable()),
    };
    studioAudioUploads = {
      findRegistration: jest
        .fn()
        .mockResolvedValue({ storageKey: KEY, subprofileId: PERSONA_ID }),
      deleteObjectsAndForget: jest.fn().mockResolvedValue(undefined),
    };
    stream = { destroy: jest.fn() };
    storage = {
      headObject: jest.fn().mockResolvedValue({
        contentType: 'audio/mpeg',
        contentLength: 5_000_000,
      }),
      openObjectStream: jest.fn().mockResolvedValue(stream),
    };
    catalog = { getTrack: jest.fn().mockResolvedValue({ id: TRACK_ID }) };
    readFacts.mockReset();
    readFacts.mockResolvedValue({
      container: 'MPEG',
      codec: 'MPEG 1 Layer 3',
      duration: 241.6,
      sampleRate: 44100,
      hasVideoTrack: false,
    });
    const dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new StudioAudioConfirmService(
      dataSource as unknown as DataSource,
      tracks as unknown as Repository<StudioTrack>,
      storage as unknown as StorageService,
      studioAudioUploads as unknown as StudioAudioUploadsService,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
    );
  });

  it('records the key, type, size and the duration read from the file', async () => {
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        audioKey: KEY,
        audioContentType: 'audio/mpeg',
        audioBytes: 5_000_000,
        durationSeconds: 242,
      }),
    );
    expect(stream.destroy).toHaveBeenCalled();
    expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
  });

  it('deletes the replaced audio once the new one is saved', async () => {
    lockedTrack = { ...lockedTrack, audioKey: OLD_KEY };
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
      OLD_KEY,
    ]);
    expect(manager.save.mock.invocationCallOrder[0]).toBeLessThan(
      studioAudioUploads.deleteObjectsAndForget.mock.invocationCallOrder[0]!,
    );
  });

  it("clears the old file's measurements and keeps chapters that start inside the new audio", async () => {
    const chapters = [
      { startSeconds: 0, title: 'Intro', artist: null },
      { startSeconds: 241, title: 'Outro', artist: 'Ana Moura' },
    ];
    lockedTrack = {
      ...lockedTrack,
      audioKey: OLD_KEY,
      durationSeconds: 300,
      waveformPeaks: Array.from({ length: 200 }, () => 90),
      loudnessLufs: -8.2,
      peakDb: -0.2,
      syncedLyrics: [{ ms: 0, text: 'First line' }],
      chapters,
    };
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        audioKey: KEY,
        durationSeconds: 242,
        waveformPeaks: null,
        loudnessLufs: null,
        peakDb: null,
        syncedLyrics: [{ ms: 0, text: 'First line' }],
        chapters,
      }),
    );
  });

  it('drops the chapters when one starts at or past the end of the new audio', async () => {
    lockedTrack = {
      ...lockedTrack,
      audioKey: OLD_KEY,
      durationSeconds: 300,
      chapters: [
        { startSeconds: 0, title: 'Intro', artist: null },
        { startSeconds: 242, title: 'Outro', artist: null },
      ],
    };
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 242, chapters: null }),
    );
  });

  it('leaves a first upload with every listening field empty', async () => {
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        waveformPeaks: null,
        loudnessLufs: null,
        peakDb: null,
        chapters: null,
      }),
    );
  });

  it('keeps the measurements when a parallel confirm already attached the same key', async () => {
    const waveformPeaks = Array.from({ length: 200 }, () => 90);
    lockedTrack = {
      ...lockedTrack,
      audioKey: KEY,
      durationSeconds: 242,
      waveformPeaks,
      loudnessLufs: -8.2,
      peakDb: -0.2,
    };
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        waveformPeaks,
        loudnessLufs: -8.2,
        peakDb: -0.2,
      }),
    );
  });

  it('returns the track unchanged when it already holds the key', async () => {
    storedTrack = { ...storedTrack, audioKey: KEY };
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it.each([
    [
      'registered to another persona',
      { storageKey: KEY, subprofileId: 'e3000000-0000-4000-8000-0000000000ff' },
    ],
    ['with no registration', null],
  ])(
    'refuses a key %s and leaves its object alone',
    async (_label, registration) => {
      studioAudioUploads.findRegistration.mockResolvedValue(registration);
      expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
        'studio_audio_wrong_owner',
      );
      expect(storage.headObject).not.toHaveBeenCalled();
      expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
    },
  );

  it('refuses a key another track already holds', async () => {
    tracks.exists.mockResolvedValue(true);
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_audio_wrong_owner',
    );
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
  });

  it('keeps an object a committed track references when a retried read fails', async () => {
    tracks.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    readFacts.mockRejectedValue(new Error('Reading the audio file timed out'));
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_audio_unreadable',
    );
    expect(tracks.exists).toHaveBeenLastCalledWith({
      where: { audioKey: KEY },
    });
    expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
  });

  it('answers wrong owner and keeps the object when another track saved the key first', async () => {
    manager.save.mockRejectedValue(
      Object.assign(new Error('duplicate key value'), {
        driverError: {
          code: '23505',
          constraint: 'UQ_studio_tracks_audio_key',
        },
      }),
    );
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_audio_wrong_owner',
    );
    expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
  });

  it('keeps the object when the save fails for a database reason, so a retry can reuse the key', async () => {
    manager.save.mockRejectedValue(new Error('deadlock detected'));
    await expect(service.confirm(USER_ID, TRACK_ID, KEY)).rejects.toThrow(
      'deadlock detected',
    );
    expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
  });

  it('lets a bucket error opening the object propagate and keeps the object', async () => {
    storage.openObjectStream.mockRejectedValue(new Error('socket hang up'));
    await expect(service.confirm(USER_ID, TRACK_ID, KEY)).rejects.toThrow(
      'socket hang up',
    );
    expect(readFacts).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
  });

  it('answers unreadable for an object that was never uploaded', async () => {
    storage.headObject.mockRejectedValue({ name: 'NotFound' });
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_audio_unreadable',
    );
    expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
  });

  it('deletes an object whose stored type disagrees with its extension', async () => {
    storage.headObject.mockResolvedValue({
      contentType: 'text/html',
      contentLength: 10,
    });
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_audio_unreadable',
    );
    expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
      KEY,
    ]);
  });

  it('deletes an object whose bytes are not audio', async () => {
    readFacts.mockResolvedValue({
      container: undefined,
      codec: undefined,
      duration: undefined,
      sampleRate: undefined,
      hasVideoTrack: false,
    });
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_audio_unreadable',
    );
    expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
      KEY,
    ]);
    expect(manager.save).not.toHaveBeenCalled();
    expect(stream.destroy).toHaveBeenCalled();
  });

  it('deletes an object the reader gives up on', async () => {
    readFacts.mockRejectedValue(new Error('Reading the audio file timed out'));
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_audio_unreadable',
    );
    expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
      KEY,
    ]);
  });

  it('refuses a member removed while the file was read and deletes the object', async () => {
    ownership.lockReleaseForWrite.mockRejectedValue(
      new NotFoundException('Release not found'),
    );
    await expect(
      service.confirm(USER_ID, TRACK_ID, KEY),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.save).not.toHaveBeenCalled();
    expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
      KEY,
    ]);
  });

  it('refuses a member removed before confirming and leaves the object alone', async () => {
    ownership.loadReleaseForWrite.mockRejectedValue(new ForbiddenException());
    await expect(
      service.confirm(USER_ID, TRACK_ID, KEY),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
  });

  it('replaces the audio of a published release, stamps the change and deletes the old object after', async () => {
    ownership.loadReleaseForWrite.mockResolvedValue(
      writable(StudioReleaseStatus.Published),
    );
    ownership.lockReleaseForWrite.mockResolvedValue(
      writable(StudioReleaseStatus.Published),
    );
    lockedTrack = { ...lockedTrack, audioKey: OLD_KEY };
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(manager.query).toHaveBeenCalledWith(STAMP_TRACKS_CHANGED_SQL, [
      RELEASE_ID,
    ]);
    expect(manager.save.mock.invocationCallOrder[0]).toBeLessThan(
      manager.query.mock.invocationCallOrder[0]!,
    );
    expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
      OLD_KEY,
    ]);
  });

  it('confirms audio on a scheduled release without stamping it', async () => {
    ownership.loadReleaseForWrite.mockResolvedValue(
      writable(StudioReleaseStatus.Scheduled),
    );
    ownership.lockReleaseForWrite.mockResolvedValue(
      writable(StudioReleaseStatus.Scheduled),
    );
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(manager.save).toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('refuses a taken-down release before the read', async () => {
    ownership.loadReleaseForWrite.mockResolvedValue(
      writable(StudioReleaseStatus.TakenDown),
    );
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_release_not_draft',
    );
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('refuses a release taken down while the file was read and deletes the object', async () => {
    ownership.lockReleaseForWrite.mockResolvedValue(
      writable(StudioReleaseStatus.TakenDown),
    );
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_release_not_draft',
    );
    expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
      KEY,
    ]);
  });

  // Studio artist kinds: the persona kind sets the cap and long files get a
  // longer read.
  it('confirms a 200 MB episode for a podcast persona with the long read', async () => {
    const podcastWrite = {
      release: {
        id: RELEASE_ID,
        subprofileId: PERSONA_ID,
        status: StudioReleaseStatus.Draft,
      },
      persona: { id: PERSONA_ID, kind: 'podcaster' },
    };
    ownership.loadReleaseForWrite.mockResolvedValue(podcastWrite);
    ownership.lockReleaseForWrite.mockResolvedValue(podcastWrite);
    storage.headObject.mockResolvedValue({
      contentType: 'audio/mpeg',
      contentLength: 200_000_000,
    });
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(readFacts).toHaveBeenCalledWith(stream, 200_000_000, 180000);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ audioBytes: 200_000_000 }),
    );
  });

  it('refuses a 60 MB file for a music persona and deletes it', async () => {
    storage.headObject.mockResolvedValue({
      contentType: 'audio/mpeg',
      contentLength: 60_000_000,
    });
    expect(await codeOf(service.confirm(USER_ID, TRACK_ID, KEY))).toBe(
      'studio_audio_unreadable',
    );
    expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
      KEY,
    ]);
    expect(readFacts).not.toHaveBeenCalled();
  });

  it('reads a file under 50 MB within the usual minute', async () => {
    await service.confirm(USER_ID, TRACK_ID, KEY);
    expect(readFacts).toHaveBeenCalledWith(stream, 5_000_000, 60_000);
  });
});
