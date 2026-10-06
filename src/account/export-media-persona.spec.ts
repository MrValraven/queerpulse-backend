import type { Repository } from 'typeorm';
import type { Message } from '../messaging/entities/message.entity';
import type { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import type { StorageService } from '../storage/storage.service';
import { MediaExportContributor } from './data-export-contributors';
import {
  PERSONA_EXPORT_FOLDER,
  mediaEntryNameForKey,
  planExportMedia,
} from './export-media';

// T17: images a member uploaded to an unlinked persona live under
// `persona/<uuid>/<uuid><ext>`, which names nobody and which no per-member
// prefix listing reaches. They still belong in the member's Art. 20 export.
const USER_ID = '11111111-2222-4333-8444-555555555555';
const PERSONA_KEY =
  'persona/0b6f2a4c-1d2e-4f30-9a8b-7c6d5e4f3a2b/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d.jpg';
const AVATAR_KEY = `avatars/${USER_ID}/6b5c4d3e-2f1a-4b0c-9d8e-7f6a5b4c3d2e.png`;

describe('persona-scoped images in the media export (T17)', () => {
  it('files a persona-scoped key under its own folder', () => {
    expect(mediaEntryNameForKey(PERSONA_KEY)).toBe(
      `${PERSONA_EXPORT_FOLDER}/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d.jpg`,
    );
  });

  it('labels a persona-scoped object with the kind its registry row records', () => {
    const plan = planExportMedia([
      {
        key: PERSONA_KEY,
        size: 10,
        lastModified: '2026-01-01T00:00:00.000Z',
        uploadKind: 'persona-cover',
      },
    ]);

    expect(plan.files).toEqual([
      expect.objectContaining({
        storageKey: PERSONA_KEY,
        uploadKind: 'persona-cover',
      }),
    ]);
  });

  it('lists the member-scoped and persona-scoped objects together', async () => {
    const storage = {
      listUserObjects: jest.fn().mockResolvedValue([
        {
          key: AVATAR_KEY,
          size: 5,
          lastModified: '2026-01-01T00:00:00.000Z',
        },
      ]),
    };
    const personaImageKeys = {
      listObjectsUploadedBy: jest.fn().mockResolvedValue([
        {
          key: PERSONA_KEY,
          size: 7,
          lastModified: '2026-02-01T00:00:00.000Z',
          uploadKind: 'avatar',
        },
      ]),
    };
    const contributor = new MediaExportContributor(
      storage as unknown as StorageService,
      {} as Repository<Message>,
      personaImageKeys as unknown as PersonaImageKeysService,
    );

    const result = await contributor.buildContribution(USER_ID);

    expect(personaImageKeys.listObjectsUploadedBy).toHaveBeenCalledWith(
      USER_ID,
    );
    expect(result.files.map((file) => file.storageKey)).toEqual([
      AVATAR_KEY,
      PERSONA_KEY,
    ]);
    expect(result.totalBytes).toBe(12);
  });
});
