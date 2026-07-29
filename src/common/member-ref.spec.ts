import { toMemberRef } from './member-ref';
import { Profile } from '../users/entities/profile.entity';

it('maps a profile to a ref and null to null', () => {
  expect(toMemberRef(null)).toBeNull();
  expect(
    toMemberRef({
      slug: 'a-b',
      firstName: 'A',
      lastName: 'B',
      avatarUrl: null,
    } as unknown as Profile),
  ).toEqual({ slug: 'a-b', firstName: 'A', lastName: 'B', avatarUrl: null });
});
