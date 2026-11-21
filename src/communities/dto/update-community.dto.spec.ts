import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { UpdateCommunityDto } from './update-community.dto';

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

describe('UpdateCommunityDto', () => {
  it('accepts a dismissal sent alone', async () => {
    const { instance, errors } = await validated(UpdateCommunityDto, {
      setupChecklistDismissed: true,
    });
    expect(errors).toEqual([]);
    expect(instance.setupChecklistDismissed).toBe(true);
  });

  it('accepts a body without the field', async () => {
    const { errors } = await validated(UpdateCommunityDto, {
      name: 'Night swim',
    });
    expect(errors).toEqual([]);
  });

  it.each([false, 'true', 1, {}])('refuses the value %p', async (value) => {
    const { errors } = await validated(UpdateCommunityDto, {
      setupChecklistDismissed: value,
    });
    expect(errors.map((error) => error.property)).toEqual([
      'setupChecklistDismissed',
    ]);
    expect(Object.keys(errors[0]?.constraints ?? {})).toEqual(['equals']);
  });

  it('lets null through as an absent field', async () => {
    const { errors } = await validated(UpdateCommunityDto, {
      setupChecklistDismissed: null,
    });
    expect(errors).toEqual([]);
  });

  it('still refuses the creation-only handle', async () => {
    const { errors } = await validated(UpdateCommunityDto, {
      handle: 'x',
      setupChecklistDismissed: true,
    });
    expect(errors.map((error) => error.property)).toEqual(['handle']);
  });
});
