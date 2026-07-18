import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

const check = (payload: Record<string, unknown>) =>
  validate(plainToInstance(UpdateProfileDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('UpdateProfileDto — now', () => {
  it('accepts a 280-character status', async () => {
    expect(await check({ now: 'x'.repeat(280) })).toHaveLength(0);
  });

  it('rejects a 281-character status', async () => {
    const errors = await check({ now: 'x'.repeat(281) });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('now');
  });

  it('accepts an empty string, which is the clearing write', async () => {
    expect(await check({ now: '' })).toHaveLength(0);
  });
});

describe('UpdateProfileDto — openTo', () => {
  it('accepts a mixed preset/custom list', async () => {
    const errors = await check({
      openTo: [
        { kind: 'preset', id: 'mentoring' },
        { kind: 'custom', label: 'A nurse or two for the testing nights' },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty list, which clears the chips', async () => {
    expect(await check({ openTo: [] })).toHaveLength(0);
  });

  it('accepts every one of the nine shared preset ids', async () => {
    for (const id of [
      'collaborating',
      'mentoring',
      'casualMeetups',
      'commissions',
      'clientWork',
      'referrals',
      'swaps',
      'studioVisits',
      'interviewees',
    ]) {
      expect(await check({ openTo: [{ kind: 'preset', id }] })).toHaveLength(0);
    }
  });

  it('rejects an unknown preset id rather than storing it', async () => {
    const errors = await check({
      openTo: [{ kind: 'preset', id: 'hiring' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('openTo');
  });

  it('rejects an unknown kind', async () => {
    const errors = await check({
      openTo: [{ kind: 'wildcard', label: 'x' }],
    });
    expect(errors).toHaveLength(1);
  });

  it('rejects more than 12 entries', async () => {
    const errors = await check({
      openTo: Array.from({ length: 13 }, (_, i) => ({
        kind: 'custom',
        label: `chip ${i}`,
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('openTo');
  });

  it('accepts exactly 12 entries', async () => {
    const errors = await check({
      openTo: Array.from({ length: 12 }, (_, i) => ({
        kind: 'custom',
        label: `chip ${i}`,
      })),
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts a 60-character custom label and rejects 61', async () => {
    expect(
      await check({ openTo: [{ kind: 'custom', label: 'x'.repeat(60) }] }),
    ).toHaveLength(0);
    expect(
      await check({ openTo: [{ kind: 'custom', label: 'x'.repeat(61) }] }),
    ).toHaveLength(1);
  });

  it('rejects an entry carrying an unknown property', async () => {
    const errors = await check({
      openTo: [{ kind: 'preset', id: 'swaps', colour: 'pink' }],
    });
    expect(errors).toHaveLength(1);
  });
});
