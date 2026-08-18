import { ValidationPipe } from '@nestjs/common';
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
    expect(errors[0]?.property).toBe('now');
  });

  it('accepts an empty string, which is the clearing write', async () => {
    expect(await check({ now: '' })).toHaveLength(0);
  });
});

describe('UpdateProfileDto — avatarUrl', () => {
  it('accepts a well-formed storage key', async () => {
    const errors = await check({
      avatarUrl:
        'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts null to clear the avatar', async () => {
    expect(await check({ avatarUrl: null })).toHaveLength(0);
  });

  it('accepts an empty string to clear the avatar', async () => {
    expect(await check({ avatarUrl: '' })).toHaveLength(0);
  });

  it('accepts an external https URL', async () => {
    expect(
      await check({ avatarUrl: 'https://images.unsplash.com/photo-1611178' }),
    ).toHaveLength(0);
  });

  it('rejects a javascript: URI', async () => {
    const errors = await check({ avatarUrl: 'javascript:alert(1)' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('avatarUrl');
  });

  it('rejects a data: URI', async () => {
    const errors = await check({
      avatarUrl: 'data:image/svg+xml,<svg/>',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('avatarUrl');
  });

  it('survives the ValidationPipe whitelist, which is what silently dropped it before', async () => {
    // REGRESSION TEST for the bug that shipped: `UpdateProfileDto` had no
    // `avatarUrl` field, so a member's uploaded photo was silently discarded
    // on save while the UI confirmed success.
    //
    // The mechanism that dropped it was the global ValidationPipe's
    // `whitelist: true` (see main.ts), which STRIPS any property carrying no
    // validation decorator. So this test must run the real pipe.
    //
    // Two weaker formulations that look like guards but are NOT, both worth
    // naming so nobody "simplifies" this back into one of them:
    //   - Asserting on ProfilesService: it applies `Object.assign(profile,
    //     rest)`, which copies `avatarUrl` whether or not the DTO declares it.
    //   - Asserting `plainToInstance(...).avatarUrl`: class-transformer copies
    //     UNDECLARED properties onto the instance too, unless
    //     `excludeExtraneousValues` is set. It would pass with the field gone.
    const storageKey =
      'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg';
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    const transformed = (await pipe.transform(
      { avatarUrl: storageKey },
      { type: 'body', metatype: UpdateProfileDto },
    )) as UpdateProfileDto;

    // Delete `avatarUrl` from the DTO and the pipe rejects the payload outright
    // (forbidNonWhitelisted), so this line never even runs — which is exactly
    // the failure we want.
    expect(transformed.avatarUrl).toBe(storageKey);
  });
});

describe('UpdateProfileDto — pronunciation/bioPt/notHereFor', () => {
  // These three follow the exact same "empty string is the clearing write"
  // shape as `now` above — ProfilesService.updateMe pulls each out of the
  // blanket Object.assign and stores `value.trim() || null`, so an empty
  // string must validate (not be rejected) here, same as `now: ''` above.

  it('accepts a well-formed pronunciation and rejects one over 80 chars', async () => {
    expect(await check({ pronunciation: 'tee-AH-go' })).toHaveLength(0);
    const errors = await check({ pronunciation: 'x'.repeat(81) });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('pronunciation');
  });

  it('accepts an empty pronunciation, which is the clearing write', async () => {
    expect(await check({ pronunciation: '' })).toHaveLength(0);
  });

  it('leaves pronunciation valid (and thus unchanged) when omitted entirely', async () => {
    // At the DTO layer "omitted" just means the key is absent — there is
    // nothing to reject, mirroring `now`'s omitted case. The actual
    // "value unchanged" behaviour lives in ProfilesService.updateMe's
    // `pronunciation !== undefined` check.
    expect(await check({ firstName: 'Tiago' })).toHaveLength(0);
  });

  it('accepts a well-formed bioPt and rejects one over 2000 chars', async () => {
    expect(await check({ bioPt: 'Uma bio em português' })).toHaveLength(0);
    const errors = await check({ bioPt: 'x'.repeat(2001) });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('bioPt');
  });

  it('accepts an empty bioPt, which is the clearing write', async () => {
    expect(await check({ bioPt: '' })).toHaveLength(0);
  });

  it('accepts a well-formed notHereFor and rejects one over 280 chars', async () => {
    expect(
      await check({ notHereFor: 'Not here for casual hookups' }),
    ).toHaveLength(0);
    const errors = await check({ notHereFor: 'x'.repeat(281) });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('notHereFor');
  });

  it('accepts an empty notHereFor, which is the clearing write', async () => {
    expect(await check({ notHereFor: '' })).toHaveLength(0);
  });
});

describe('UpdateProfileDto — hiddenUntil', () => {
  it('accepts a well-formed ISO 8601 timestamp', async () => {
    expect(
      await check({ hiddenUntil: '2026-08-19T12:00:00.000Z' }),
    ).toHaveLength(0);
  });

  it('accepts null, which clears it early', async () => {
    expect(await check({ hiddenUntil: null })).toHaveLength(0);
  });

  it('rejects a non-ISO-8601 string rather than storing a bad timestamp', async () => {
    const errors = await check({ hiddenUntil: 'not-a-date' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('hiddenUntil');
  });
});

describe('UpdateProfileDto — photoVisible/hoodVisible/vouchersVisible', () => {
  it('accepts booleans for all three visibility toggles', async () => {
    expect(
      await check({
        photoVisible: false,
        hoodVisible: true,
        vouchersVisible: false,
      }),
    ).toHaveLength(0);
  });

  it('rejects a non-boolean photoVisible', async () => {
    const errors = await check({ photoVisible: 'nope' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('photoVisible');
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
    expect(errors[0]?.property).toBe('openTo');
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
    expect(errors[0]?.property).toBe('openTo');
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
