import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SavedItemBodyDto } from './saved-item-body.dto';
import { SavedKind } from '../entities/saved-item.entity';

/**
 * Guards ENG-45: this body is member-controlled and three of its fields are
 * echoed onto the `@Public()` share-link read, so the caps and the
 * app-relative `href` rule are the only thing standing between a share link
 * and an unbounded blob.
 *
 * The "accepts" cases are deliberately the real shapes the frontend sends, so a
 * cap tightened later without checking the call sites fails here rather than
 * in production on somebody's save.
 */
describe('SavedItemBodyDto', () => {
  const validBody = {
    kind: SavedKind.Article,
    title: 'Coming out, again, at forty',
    href: '/magazine/article?id=coming-out-again',
    meta: 'Sofia Andrade · 6 min',
    description: 'A gentle primer on telling the same story twice.',
    readTime: '6 min',
  };

  const propertiesWithErrors = async (
    payload: Record<string, unknown>,
  ): Promise<string[]> => {
    const errors = await validate(plainToInstance(SavedItemBodyDto, payload));
    return errors.map((error) => error.property);
  };

  it('accepts the shape the frontend actually sends', async () => {
    expect(await propertiesWithErrors(validBody)).toEqual([]);
  });

  it('accepts a body with only the two required fields', async () => {
    expect(
      await propertiesWithErrors({
        kind: SavedKind.Post,
        title: 'A community post',
      }),
    ).toEqual([]);
  });

  it('accepts an empty href, which is what an unset form field sends', async () => {
    expect(await propertiesWithErrors({ ...validBody, href: '' })).toEqual([]);
  });

  it.each([
    ['title', 501],
    ['meta', 501],
    ['description', 10001],
    ['readTime', 201],
    ['href', 2001],
  ])('rejects %s one character over its cap', async (field, length) => {
    // `href` has to stay a legal path while being over-long, or the failure
    // would come from the pattern instead of the length.
    const overLongValue =
      field === 'href' ? `/${'x'.repeat(length - 1)}` : 'x'.repeat(length);
    expect(
      await propertiesWithErrors({ ...validBody, [field]: overLongValue }),
    ).toContain(field);
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['https://evil.example/phish'],
    // Protocol-relative: a browser resolves this off-site even though it opens
    // with a slash, which is why the pattern needs the negative lookahead.
    ['//evil.example/phish'],
    ['/\\evil.example/phish'],
    ['/path with a space'],
    ['relative/without/a/leading/slash'],
  ])('rejects href %s', async (href) => {
    expect(await propertiesWithErrors({ ...validBody, href })).toContain(
      'href',
    );
  });

  it('rejects an empty title, since the card would have nothing to show', async () => {
    expect(await propertiesWithErrors({ ...validBody, title: '' })).toContain(
      'title',
    );
  });

  it('rejects a kind outside the saved taxonomy', async () => {
    expect(
      await propertiesWithErrors({ ...validBody, kind: 'not-a-real-kind' }),
    ).toContain('kind');
  });
});
