import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  AddVjPackClipDto,
  CreateVjClipDto,
  CreateVjPackDto,
  CreateVjSceneDto,
  CreateVjSetlistDto,
  RenameVjPackDto,
  RenameVjSetlistDto,
  ReorderVjPackClipsDto,
  ReorderVjPacksDto,
  ReorderVjScenesDto,
  ReorderVjSetlistsDto,
  SetVjClipPreviewDto,
  SetVjPackEventDto,
  SetVjSetlistItemsDto,
  UpdateVjClipDto,
  UpdateVjSceneDto,
  VjClipsMediaQuery,
  VjPackMediaQuery,
} from './vj.dto';

/** Runs a plain value through the same transform and validation the global
 *  `ValidationPipe` applies, and answers the instance with its errors. */
async function validated<Dto extends object>(
  dtoClass: new () => Dto,
  plain: Record<string, unknown>,
) {
  const instance = plainToInstance(
    dtoClass,
    plain,
    VALIDATION_PIPE_OPTIONS.transformOptions,
  );
  const errors = await validate(instance, VALIDATION_PIPE_OPTIONS);
  return { instance, errors };
}

describe('VJ DTOs', () => {
  it('lets every create value through so the service answers its code', async () => {
    const plain = {
      title: 5,
      storageKey: [],
      width: '1',
      durationMs: {},
      fitMode: 7,
      packId: 5,
    };
    const { instance, errors } = await validated(CreateVjClipDto, plain);
    expect(errors).toHaveLength(0);
    expect({ ...instance }).toEqual(plain);
  });

  it('lets every pack and update value through', async () => {
    const cases: Array<[new () => object, Record<string, unknown>]> = [
      [CreateVjPackDto, { name: 5 }],
      [RenameVjPackDto, { name: null }],
      [ReorderVjPacksDto, { packIds: 'a,b' }],
      [AddVjPackClipDto, { clipId: 7 }],
      [ReorderVjPackClipsDto, { clipIds: [1, 2] }],
      [UpdateVjClipDto, { title: 5, fitMode: [] }],
    ];
    for (const [dtoClass, plain] of cases) {
      const { instance, errors } = await validated(dtoClass, plain);
      expect(errors).toHaveLength(0);
      expect({ ...instance }).toEqual(plain);
    }
  });

  it('lets repeated query values through', async () => {
    const plain = { clipIds: ['a', 'b'] };
    const { instance, errors } = await validated(VjPackMediaQuery, plain);
    expect(errors).toHaveLength(0);
    expect({ ...instance }).toEqual(plain);
  });

  it('lets every v2 clip update value through', async () => {
    const plain = {
      title: 'Peak hour',
      fitMode: 'fit',
      isFavorite: 'true',
      defaultSpeed: '1',
      loopInMs: -1,
      loopOutMs: null,
      loopMode: 7,
    };
    const { instance, errors } = await validated(UpdateVjClipDto, plain);
    expect(errors).toHaveLength(0);
    expect({ ...instance }).toEqual(plain);
  });

  it('lets every field of each new DTO through so the service answers its code', async () => {
    const cases: Array<[new () => object, Record<string, unknown>]> = [
      [SetVjClipPreviewDto, { previewStorageKey: 5 }],
      [SetVjPackEventDto, { eventId: null }],
      [SetVjPackEventDto, { eventId: 'nope' }],
      [CreateVjSceneDto, { name: 5, packId: 'nope', look: 'flat' }],
      [
        CreateVjSceneDto,
        { name: 'Glow', packId: null, look: { source: null } },
      ],
      [UpdateVjSceneDto, { name: null, packId: 7, look: [] }],
      [ReorderVjScenesDto, { sceneIds: 'a,b' }],
      [CreateVjSetlistDto, { name: [], sceneIds: [1, 2] }],
      [RenameVjSetlistDto, { name: 5 }],
      [ReorderVjSetlistsDto, { setlistIds: { first: 'a' } }],
      [SetVjSetlistItemsDto, { sceneIds: 'a' }],
      [VjClipsMediaQuery, { clipIds: ['a', 'b'] }],
    ];
    for (const [dtoClass, plain] of cases) {
      const { instance, errors } = await validated(dtoClass, plain);
      expect(errors).toHaveLength(0);
      expect({ ...instance }).toEqual(plain);
    }
  });

  it('lets an empty body through each new DTO', async () => {
    const dtoClasses: Array<new () => object> = [
      SetVjClipPreviewDto,
      SetVjPackEventDto,
      CreateVjSceneDto,
      UpdateVjSceneDto,
      ReorderVjScenesDto,
      CreateVjSetlistDto,
      RenameVjSetlistDto,
      ReorderVjSetlistsDto,
      SetVjSetlistItemsDto,
      VjClipsMediaQuery,
    ];
    for (const dtoClass of dtoClasses) {
      const { errors } = await validated(dtoClass, {});
      expect(errors).toHaveLength(0);
    }
  });

  it('refuses an undeclared property on the new DTOs', async () => {
    const scene = await validated(CreateVjSceneDto, {
      name: 'Glow',
      position: 3,
    });
    expect(scene.errors).toHaveLength(1);
    expect(scene.errors[0]?.property).toBe('position');
    const items = await validated(SetVjSetlistItemsDto, {
      sceneIds: [],
      setlistId: 'x',
    });
    expect(items.errors).toHaveLength(1);
    expect(items.errors[0]?.property).toBe('setlistId');
  });

  it('still refuses an undeclared property', async () => {
    const create = await validated(CreateVjClipDto, {
      title: 'a',
      mimeType: 'video/mp4',
    });
    expect(create.errors).toHaveLength(1);
    expect(create.errors[0]?.property).toBe('mimeType');
    const update = await validated(UpdateVjClipDto, {
      title: 'a',
      storageKey: 'x',
    });
    expect(update.errors).toHaveLength(1);
    expect(update.errors[0]?.property).toBe('storageKey');
  });
});
