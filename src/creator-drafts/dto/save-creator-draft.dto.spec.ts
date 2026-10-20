import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { SaveCreatorDraftDto } from './save-creator-draft.dto';

const VALID_BODY = {
  payload: { title: 'Picnic in the park' },
  payloadVersion: 1,
  baseRevision: 3,
  progress: { done: 2, total: 5 },
  missing: ['startsAt'],
};

/** The production pipe's transform and whitelist rules. */
async function validateBody(body: Record<string, unknown>) {
  const instance = plainToInstance(
    SaveCreatorDraftDto,
    body,
    VALIDATION_PIPE_OPTIONS.transformOptions,
  );
  const errors = await validate(instance, {
    whitelist: VALIDATION_PIPE_OPTIONS.whitelist,
    forbidNonWhitelisted: VALIDATION_PIPE_OPTIONS.forbidNonWhitelisted,
  });
  return { instance, errors };
}

describe('SaveCreatorDraftDto', () => {
  it('accepts a full body', async () => {
    const { errors } = await validateBody(VALID_BODY);
    expect(errors).toEqual([]);
  });

  it('accepts nulls for the base, the progress and the missing codes, and keeps unknown payload keys', async () => {
    const { instance, errors } = await validateBody({
      payload: { anything: { nested: true } },
      payloadVersion: 1,
      baseRevision: null,
      progress: null,
      missing: null,
    });
    expect(errors).toEqual([]);
    expect(instance.payload.anything).toEqual({ nested: true });
  });

  it('accepts camelCase listing editor codes as missing codes', async () => {
    const { errors } = await validateBody({
      ...VALID_BODY,
      missing: ['saferSpacePolicyUrl', 'hoursExceptions', 'whatItIs'],
    });
    expect(errors).toEqual([]);
  });

  it.each([
    ['an omitted base revision', { baseRevision: undefined }],
    ['an omitted progress', { progress: undefined }],
    ['an omitted missing list', { missing: undefined }],
    ['a zero payload version', { payloadVersion: 0 }],
    ['a payload version of 1001', { payloadVersion: 1001 }],
    ['a zero base revision', { baseRevision: 0 }],
    ['a base revision past the int column', { baseRevision: 2_147_483_648 }],
    ['a payload that is an array', { payload: [] }],
    ['51 missing codes', { missing: Array.from({ length: 51 }, () => 'what') }],
    ['a 65 character code', { missing: ['x'.repeat(65)] }],
    ['a total of 51', { progress: { done: 1, total: 51 } }],
    ['a negative done', { progress: { done: -1, total: 5 } }],
    ['an unknown progress key', { progress: { done: 1, total: 5, extra: 1 } }],
    ['an unknown body key', { title: 'Picnic' }],
  ])('refuses %s', async (_label, overrides) => {
    const { errors } = await validateBody({ ...VALID_BODY, ...overrides });
    expect(errors.length).toBeGreaterThan(0);
  });
});
