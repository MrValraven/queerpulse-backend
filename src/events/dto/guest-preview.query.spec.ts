import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GuestPreviewQuery } from './guest-preview.query';

describe('GuestPreviewQuery', () => {
  const errorsFor = (query: Record<string, unknown>) =>
    validate(plainToInstance(GuestPreviewQuery, query));

  it('accepts no viewAs', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it.each(['member', 'going', 'waitlisted'])('accepts %s', async (role) => {
    expect(await errorsFor({ viewAs: role })).toHaveLength(0);
  });

  it.each(['host', 'organizer', ''])('rejects %p', async (role) => {
    expect(await errorsFor({ viewAs: role })).toHaveLength(1);
  });
});
