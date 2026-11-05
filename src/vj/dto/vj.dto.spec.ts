import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  AddVjPackClipDto,
  CreateVjClipDto,
  CreateVjPackDto,
  RenameVjPackDto,
  ReorderVjPackClipsDto,
  ReorderVjPacksDto,
  UpdateVjClipDto,
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
