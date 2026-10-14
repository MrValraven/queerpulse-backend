import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import { SubprofilePost } from './entities/subprofile-post.entity';
import { toPersonaPost } from './persona-post-response';

const IMAGE_KEY =
  'persona/dd000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000002.jpg';

const post = (overrides: Partial<SubprofilePost> = {}): SubprofilePost => ({
  id: 'post-1',
  subprofileId: 'persona-1',
  authorUserId: 'member-1',
  body: 'New single out Friday',
  linkUrl: null,
  imageKey: null,
  createdAt: new Date('2026-10-13T09:00:00.000Z'),
  editedAt: null,
  ...overrides,
});

describe('toPersonaPost', () => {
  beforeAll(() => setImageUrlBase('https://api.test'));
  afterAll(() => resetImageUrlBaseForTesting());

  it('writes only the contract fields', () => {
    const wire = toPersonaPost(post(), false);
    expect(wire).toEqual({
      id: 'post-1',
      body: 'New single out Friday',
      linkUrl: null,
      imageUrl: null,
      createdAt: '2026-10-13T09:00:00.000Z',
      editedAt: null,
      canEdit: false,
    });
    expect(JSON.stringify(wire)).not.toContain('member-1');
    expect(JSON.stringify(wire)).not.toContain('persona-1');
  });

  it('serves the photo through the files route and marks the edit', () => {
    const wire = toPersonaPost(
      post({
        imageKey: IMAGE_KEY,
        linkUrl: 'https://nightshift.bandcamp.com',
        editedAt: new Date('2026-10-13T10:00:00.000Z'),
      }),
      true,
    );
    expect(wire.imageUrl).toBe(toImageUrl(IMAGE_KEY));
    expect(wire.linkUrl).toBe('https://nightshift.bandcamp.com');
    expect(wire.editedAt).toBe('2026-10-13T10:00:00.000Z');
    expect(wire.canEdit).toBe(true);
  });
});
