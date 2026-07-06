import { toMemberRef } from './member-ref';

it('maps a profile to a ref and null to null', () => {
  expect(toMemberRef(null)).toBeNull();
  expect(
    toMemberRef({
      slug: 'a-b',
      firstName: 'A',
      lastName: 'B',
      avatarUrl: null,
    } as any),
  ).toEqual({ slug: 'a-b', firstName: 'A', lastName: 'B', avatarUrl: null });
});
