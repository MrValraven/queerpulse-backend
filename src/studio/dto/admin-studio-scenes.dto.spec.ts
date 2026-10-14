import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateAdminStudioSceneDto,
  PinAdminStudioSceneEventDto,
  ReorderAdminStudioScenesDto,
  UpdateAdminStudioSceneDto,
} from './admin-studio-scenes.dto';

const errorsFor = async <BodyClass extends object>(
  dtoClass: ClassConstructor<BodyClass>,
  body: object,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

describe('Admin scene bodies', () => {
  it('takes a trimmed name and city of 1 to 60 characters', async () => {
    const trimmed = plainToInstance(CreateAdminStudioSceneDto, {
      name: '  Lisbon ballroom ',
      city: ' Lisbon ',
    });
    expect(trimmed.name).toBe('Lisbon ballroom');
    expect(trimmed.city).toBe('Lisbon');
    expect(
      await errorsFor(CreateAdminStudioSceneDto, {
        name: '   ',
        city: 'x'.repeat(61),
      }),
    ).toEqual(['city', 'name']);
  });

  it('takes an optional slug that matches the pattern, 2 to 60 long', async () => {
    expect(
      await errorsFor(CreateAdminStudioSceneDto, {
        name: 'Porto',
        city: 'Porto',
        slug: 'porto-nights',
      }),
    ).toEqual([]);
    for (const slug of ['Porto', 'p', 'porto--nights', 'x'.repeat(61)]) {
      expect(
        await errorsFor(CreateAdminStudioSceneDto, {
          name: 'Porto',
          city: 'Porto',
          slug,
        }),
      ).toEqual(['slug']);
    }
  });

  it('bounds the blurb at 500 and takes null for the blurb and the cover', async () => {
    expect(
      await errorsFor(CreateAdminStudioSceneDto, {
        name: 'Porto',
        city: 'Porto',
        blurb: null,
        coverKey: null,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(CreateAdminStudioSceneDto, {
        name: 'Porto',
        city: 'Porto',
        blurb: 'x'.repeat(501),
      }),
    ).toEqual(['blurb']);
  });

  it('refuses null for the name, the city and the slug on an edit', async () => {
    expect(
      await errorsFor(UpdateAdminStudioSceneDto, {
        name: null,
        city: null,
        slug: null,
      }),
    ).toEqual(['city', 'name', 'slug']);
    expect(await errorsFor(UpdateAdminStudioSceneDto, {})).toEqual([]);
  });

  it('takes scene ids for a reorder and one event id for a pin', async () => {
    expect(
      await errorsFor(ReorderAdminStudioScenesDto, {
        sceneIds: ['e9000000-0000-4000-8000-000000000001'],
      }),
    ).toEqual([]);
    expect(
      await errorsFor(PinAdminStudioSceneEventDto, { eventId: 'ballroom' }),
    ).toEqual(['eventId']);
  });
});
