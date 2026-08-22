import { toMemberRef } from './member-ref';
import { Profile } from '../users/entities/profile.entity';

it('maps a profile to a ref and null to null', () => {
  expect(toMemberRef(null)).toBeNull();
  expect(
    toMemberRef({
      slug: 'a-b',
      firstName: 'A',
      lastName: 'B',
      pronouns: 'they/them',
      avatarUrl: null,
      photoVisible: true,
    } as unknown as Profile),
  ).toEqual({
    slug: 'a-b',
    firstName: 'A',
    lastName: 'B',
    pronouns: 'they/them',
    avatarUrl: null,
  });
});

it('exposes the avatar when photoVisible is on (M5)', () => {
  const ref = toMemberRef({
    slug: 'a-b',
    firstName: 'A',
    lastName: 'B',
    pronouns: null,
    avatarUrl: 'avatars/a-b/pic.jpg',
    photoVisible: true,
  } as unknown as Profile);
  expect(ref?.avatarUrl).not.toBeNull();
});

it('nulls the avatar when photoVisible is off, regardless of a stored key (M5)', () => {
  const ref = toMemberRef({
    slug: 'a-b',
    firstName: 'A',
    lastName: 'B',
    pronouns: null,
    avatarUrl: 'avatars/a-b/pic.jpg',
    photoVisible: false,
  } as unknown as Profile);
  expect(ref?.avatarUrl).toBeNull();
});
