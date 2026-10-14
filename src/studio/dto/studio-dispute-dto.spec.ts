import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateStudioDisputeDto } from './create-studio-dispute.dto';
import { DecideStudioDisputeDto } from './decide-studio-dispute.dto';

describe('Studio dispute bodies', () => {
  it('takes an artist note of 1 to 1000 characters after trimming', async () => {
    const errorsFor = async (note: unknown) =>
      (await validate(plainToInstance(CreateStudioDisputeDto, { note })))
        .length;
    expect(await errorsFor('I hold the rights to every recording')).toBe(0);
    expect(await errorsFor('x'.repeat(1000))).toBe(0);
    expect(await errorsFor('   ')).toBe(1);
    expect(await errorsFor('x'.repeat(1001))).toBe(1);
    expect(await errorsFor(undefined)).toBe(1);
  });

  it('trims the note before it is stored', () => {
    expect(
      plainToInstance(CreateStudioDisputeDto, {
        note: '  Here is the licence  ',
      }).note,
    ).toBe('Here is the licence');
  });

  it('takes a staff reply of 1 to 1000 characters after trimming', async () => {
    const errorsFor = async (reply: unknown) =>
      (await validate(plainToInstance(DecideStudioDisputeDto, { reply })))
        .length;
    expect(await errorsFor('Thanks, the licence checks out')).toBe(0);
    expect(await errorsFor('')).toBe(1);
    expect(await errorsFor('x'.repeat(1001))).toBe(1);
    expect(await errorsFor(null)).toBe(1);
  });
});
