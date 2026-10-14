import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateStudioPersonaCreditDto } from './create-studio-persona-credit.dto';

const errorsFor = async (body: object): Promise<string[]> =>
  (await validate(plainToInstance(CreateStudioPersonaCreditDto, body)))
    .map((error) => error.property)
    .sort();

describe('Studio persona credit body', () => {
  it('takes a handle and a role from the vocabulary', async () => {
    expect(
      await errorsFor({ handle: '@river-ink', role: 'cover-art' }),
    ).toEqual([]);
  });

  it('refuses a missing handle and a role outside the vocabulary', async () => {
    expect(await errorsFor({ role: 'drums' })).toEqual(['handle', 'role']);
  });

  // The service answers a long handle with 422, the way it answers an
  // unknown one; the body only bounds the request size.
  it('bounds the handle at 200 characters', async () => {
    expect(await errorsFor({ handle: 'x'.repeat(201), role: 'other' })).toEqual(
      ['handle'],
    );
  });
});
