import {
  isDraftMeta,
  MAX_DRAFT_META_ARRAY_LENGTH,
  MAX_DRAFT_META_BYTES,
  MAX_DRAFT_META_KEYS,
  MAX_DRAFT_META_KEY_LENGTH,
  MAX_DRAFT_META_VALUE_LENGTH,
} from './is-draft-meta.decorator';

describe('isDraftMeta', () => {
  it('accepts what the forum composer actually stores', () => {
    expect(
      isDraftMeta({
        title: 'A quiet Sunday in Arroios',
        category: 'life',
        communitySlug: 'sapatilhas',
        tags: ['lisboa', 'arroios'],
        imageKey: 'community-posts/2026/abc.jpg',
        imagePreviewUrl: null,
      }),
    ).toBe(true);
  });

  it('accepts null (the bag is cleared) and an empty bag', () => {
    expect(isDraftMeta(null)).toBe(true);
    expect(isDraftMeta({})).toBe(true);
  });

  it('accepts numbers and booleans, since composers are free to park either', () => {
    expect(isDraftMeta({ step: 2, isOfficial: false })).toBe(true);
  });

  // Every rejection below is a shape that would otherwise reach a jsonb column
  // an autosave rewrites every 1.5 seconds, on a route open to every member.
  it('refuses a nested object, the depth bomb a bare @IsObject() would allow', () => {
    expect(isDraftMeta({ image: { key: 'a', url: 'b' } })).toBe(false);
    expect(isDraftMeta({ tags: [['lisboa']] })).toBe(false);
  });

  it('refuses a non-object', () => {
    expect(isDraftMeta('lisboa')).toBe(false);
    expect(isDraftMeta(7)).toBe(false);
    expect(isDraftMeta([{ tags: [] }])).toBe(false);
  });

  it('refuses a prototype-polluting key', () => {
    expect(isDraftMeta(JSON.parse('{"__proto__": "x"}'))).toBe(false);
    expect(isDraftMeta({ constructor: 'x' })).toBe(false);
    expect(isDraftMeta({ prototype: 'x' })).toBe(false);
  });

  it('refuses a key that is not a plain identifier', () => {
    expect(isDraftMeta({ 'tags[]': 'x' })).toBe(false);
    expect(isDraftMeta({ '': 'x' })).toBe(false);
    expect(
      isDraftMeta({ ['a'.repeat(MAX_DRAFT_META_KEY_LENGTH + 1)]: 'x' }),
    ).toBe(false);
  });

  it('refuses more keys than one composer could need', () => {
    const tooMany: Record<string, string> = {};
    for (let index = 0; index <= MAX_DRAFT_META_KEYS; index += 1) {
      tooMany[`key_${index}`] = 'x';
    }
    expect(Object.keys(tooMany).length).toBeGreaterThan(MAX_DRAFT_META_KEYS);
    expect(isDraftMeta(tooMany)).toBe(false);
  });

  it('refuses an over-long string value, so prose cannot be smuggled in here', () => {
    expect(
      isDraftMeta({ imageKey: 'a'.repeat(MAX_DRAFT_META_VALUE_LENGTH) }),
    ).toBe(true);
    expect(
      isDraftMeta({ imageKey: 'a'.repeat(MAX_DRAFT_META_VALUE_LENGTH + 1) }),
    ).toBe(false);
  });

  it('refuses an over-long string list', () => {
    const tags = Array.from(
      { length: MAX_DRAFT_META_ARRAY_LENGTH + 1 },
      (_unused, index) => `tag-${index}`,
    );
    expect(isDraftMeta({ tags })).toBe(false);
  });

  it('refuses a bag over the serialized byte cap', () => {
    // Inside the key/value caps individually, over budget together: the case
    // the per-field checks alone would let through.
    const bag: Record<string, string> = {};
    for (let index = 0; index < MAX_DRAFT_META_KEYS; index += 1) {
      bag[`key_${index}`] = 'a'.repeat(MAX_DRAFT_META_VALUE_LENGTH);
    }
    expect(Buffer.byteLength(JSON.stringify(bag), 'utf8')).toBeGreaterThan(
      MAX_DRAFT_META_BYTES,
    );
    expect(isDraftMeta(bag)).toBe(false);
  });

  it('refuses a number that would not survive serialization', () => {
    expect(isDraftMeta({ step: Number.NaN })).toBe(false);
    expect(isDraftMeta({ step: Number.POSITIVE_INFINITY })).toBe(false);
  });
});
