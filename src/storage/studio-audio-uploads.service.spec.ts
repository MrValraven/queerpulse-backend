import { HttpException, PayloadTooLargeException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { StudioAudioUpload } from './entities/studio-audio-upload.entity';
import { StorageService } from './storage.service';
import { StudioAudioUploadsService } from './studio-audio-uploads.service';

const USER_ID = '6a000000-0000-4000-8000-000000000001';
const PERSONA_ID = '6b000000-0000-4000-8000-000000000001';
const KEY =
  'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const body = (error as HttpException).getResponse() as { code?: string };
    return body.code;
  }
}

describe('StudioAudioUploadsService', () => {
  let uploads: {
    query: jest.Mock;
    insert: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
  };
  let storage: {
    presignStudioAudioUpload: jest.Mock;
    deleteObjectByKey: jest.Mock;
    describeObject: jest.Mock;
  };
  let service: StudioAudioUploadsService;

  const answerChecks = (row: {
    has_grant: boolean;
    persona_kind: string | null;
    is_member: boolean;
  }) => uploads.query.mockResolvedValue([row]);

  beforeEach(() => {
    uploads = {
      query: jest.fn(),
      insert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      presignStudioAudioUpload: jest.fn().mockResolvedValue({
        uploadUrl: 'https://bucket.example/put',
        key: KEY,
        expiresIn: 300,
      }),
      deleteObjectByKey: jest.fn().mockResolvedValue(undefined),
      describeObject: jest.fn(),
    };
    service = new StudioAudioUploadsService(
      storage as unknown as StorageService,
      uploads as unknown as Repository<StudioAudioUpload>,
    );
  });

  const presign = () =>
    service.presign(USER_ID, {
      subprofileId: PERSONA_ID,
      contentType: 'audio/mpeg',
      byteSize: 2048,
    });

  it('refuses a member with no Studio grant', async () => {
    answerChecks({ has_grant: false, persona_kind: 'dj', is_member: true });
    expect(await codeOf(presign())).toBe('studio_access_required');
    expect(storage.presignStudioAudioUpload).not.toHaveBeenCalled();
  });

  it('refuses a non-member and an unknown persona with the same code', async () => {
    answerChecks({ has_grant: true, persona_kind: 'dj', is_member: false });
    expect(await codeOf(presign())).toBe('studio_not_persona_owner');
    answerChecks({ has_grant: true, persona_kind: null, is_member: false });
    expect(await codeOf(presign())).toBe('studio_not_persona_owner');
  });

  it('refuses a writer persona', async () => {
    answerChecks({ has_grant: true, persona_kind: 'writer', is_member: true });
    expect(await codeOf(presign())).toBe('studio_persona_kind_not_allowed');
  });

  it('presigns and records the persona the key belongs to', async () => {
    answerChecks({
      has_grant: true,
      persona_kind: 'musician',
      is_member: true,
    });
    const result = await presign();
    expect(storage.presignStudioAudioUpload).toHaveBeenCalledWith({
      contentType: 'audio/mpeg',
      byteSize: 2048,
      maxBytes: 52428800,
    });
    expect(uploads.insert).toHaveBeenCalledWith({
      storageKey: KEY,
      subprofileId: PERSONA_ID,
      uploadedById: USER_ID,
    });
    expect(result.key).toBe(KEY);
  });

  it('records nothing when the file is too large', async () => {
    answerChecks({ has_grant: true, persona_kind: 'dj', is_member: true });
    storage.presignStudioAudioUpload.mockRejectedValue(
      new PayloadTooLargeException(),
    );
    await expect(presign()).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(uploads.insert).not.toHaveBeenCalled();
  });

  it('deletes each object and its registry row, and carries on past a failure', async () => {
    const SECOND_KEY = KEY.replace('.mp3', '.m4a');
    storage.deleteObjectByKey
      .mockRejectedValueOnce(new Error('bucket unavailable'))
      .mockResolvedValueOnce(undefined);
    await service.deleteObjectsAndForget([KEY, SECOND_KEY]);
    expect(storage.deleteObjectByKey).toHaveBeenCalledTimes(2);
    expect(uploads.delete).toHaveBeenCalledTimes(1);
    expect(uploads.delete).toHaveBeenCalledWith({ storageKey: SECOND_KEY });
  });

  it('lists the audio a member uploaded that still exists in the bucket', async () => {
    uploads.find.mockResolvedValue([
      { storageKey: KEY },
      { storageKey: 'gone' },
    ]);
    storage.describeObject.mockImplementation((key: string) =>
      Promise.resolve(
        key === KEY
          ? { key, size: 10, lastModified: '2026-10-08T00:00:00.000Z' }
          : null,
      ),
    );
    expect(await service.listObjectsUploadedBy(USER_ID)).toEqual([
      {
        key: KEY,
        size: 10,
        lastModified: '2026-10-08T00:00:00.000Z',
        uploadKind: 'studio_audio',
      },
    ]);
  });

  // Studio artist kinds: the persona kind sets the cap.
  it('presigns a podcast persona up to 250 MB', async () => {
    answerChecks({
      has_grant: true,
      persona_kind: 'podcaster',
      is_member: true,
    });
    await presign();
    expect(storage.presignStudioAudioUpload).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 262144000 }),
    );
  });

  it('presigns a poet persona, the new kinds included, with the 50 MB cap', async () => {
    answerChecks({ has_grant: true, persona_kind: 'poet', is_member: true });
    await presign();
    expect(storage.presignStudioAudioUpload).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 52428800 }),
    );
  });

  it('records nothing when the cap refuses the file', async () => {
    answerChecks({ has_grant: true, persona_kind: 'dj', is_member: true });
    storage.presignStudioAudioUpload.mockRejectedValue(
      new PayloadTooLargeException('File too large'),
    );
    await expect(presign()).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(uploads.insert).not.toHaveBeenCalled();
  });

  // Open item A: who may confirm a Studio audio key is who may presign it,
  // and each refusal names its own reason.
  describe('confirmUploadRefusal', () => {
    const CO_OWNER_ID = '6a000000-0000-4000-8000-000000000002';

    function registered(): void {
      uploads.findOne.mockResolvedValue({
        storageKey: KEY,
        subprofileId: PERSONA_ID,
        uploadedById: USER_ID,
      });
    }

    it('lets the uploader confirm while the presign checks still pass', async () => {
      registered();
      answerChecks({ has_grant: true, persona_kind: 'dj', is_member: true });
      await expect(
        service.confirmUploadRefusal(USER_ID, KEY),
      ).resolves.toBeNull();
      expect(uploads.findOne).toHaveBeenCalledWith({
        where: { storageKey: KEY },
      });
      expect(uploads.query).toHaveBeenCalledWith(expect.any(String), [
        USER_ID,
        PERSONA_ID,
      ]);
    });

    it('lets a co-owner of the persona confirm, checked against the registered persona', async () => {
      registered();
      answerChecks({
        has_grant: true,
        persona_kind: 'musician',
        is_member: true,
      });
      await expect(
        service.confirmUploadRefusal(CO_OWNER_ID, KEY),
      ).resolves.toBeNull();
      expect(uploads.query).toHaveBeenCalledWith(expect.any(String), [
        CO_OWNER_ID,
        PERSONA_ID,
      ]);
    });

    it('names an ended Studio grant first, with or without a registry row', async () => {
      answerChecks({ has_grant: false, persona_kind: null, is_member: false });
      await expect(service.confirmUploadRefusal(USER_ID, KEY)).resolves.toBe(
        'studio_access_required',
      );
      expect(uploads.query).toHaveBeenCalledWith(expect.any(String), [
        USER_ID,
        null,
      ]);
      registered();
      answerChecks({ has_grant: false, persona_kind: 'dj', is_member: false });
      await expect(service.confirmUploadRefusal(USER_ID, KEY)).resolves.toBe(
        'studio_access_required',
      );
    });

    it('answers a key with no registry row and a non-member alike', async () => {
      answerChecks({ has_grant: true, persona_kind: null, is_member: false });
      await expect(service.confirmUploadRefusal(USER_ID, KEY)).resolves.toBe(
        'upload_not_yours',
      );
      registered();
      answerChecks({ has_grant: true, persona_kind: 'dj', is_member: false });
      await expect(
        service.confirmUploadRefusal(CO_OWNER_ID, KEY),
      ).resolves.toBe('upload_not_yours');
    });

    it('names a persona kind that can no longer upload audio', async () => {
      registered();
      answerChecks({
        has_grant: true,
        persona_kind: 'writer',
        is_member: true,
      });
      await expect(service.confirmUploadRefusal(USER_ID, KEY)).resolves.toBe(
        'studio_persona_kind_not_allowed',
      );
    });
  });
});
