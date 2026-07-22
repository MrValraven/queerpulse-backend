import { plainToInstance } from 'class-transformer';
import { IsOptional, validateSync } from 'class-validator';
import { IsImageReference } from './is-image-reference.decorator';

class ImageHolder {
  @IsOptional()
  @IsImageReference()
  imageUrl?: string | null;
}

function firstError(value: unknown): string | undefined {
  const instance = plainToInstance(ImageHolder, { imageUrl: value });
  const errors = validateSync(instance);
  return errors[0]?.constraints
    ? Object.values(errors[0].constraints)[0]
    : undefined;
}

// `ImageHolder` above pairs `@IsImageReference()` with `@IsOptional()`, which
// short-circuits validation before the decorator ever runs for `null`/`''` —
// so its "accepts null" case (below) exercises `@IsOptional()`, not the
// decorator's own null branch. This class has NO `@IsOptional()`, so the
// decorator itself is what has to accept or reject `null` and `''`.
class RequiredImageHolder {
  @IsImageReference()
  imageUrl: string | null;
}

function firstRequiredError(value: unknown): string | undefined {
  const instance = plainToInstance(RequiredImageHolder, { imageUrl: value });
  const errors = validateSync(instance);
  return errors[0]?.constraints
    ? Object.values(errors[0].constraints)[0]
    : undefined;
}

describe('IsImageReference', () => {
  it('accepts a storage key', () => {
    expect(
      firstError(
        'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg',
      ),
    ).toBeUndefined();
  });

  it('accepts an external https URL', () => {
    expect(
      firstError('https://images.unsplash.com/photo-1611178204388'),
    ).toBeUndefined();
  });

  it('accepts null, which clears the field', () => {
    expect(firstError(null)).toBeUndefined();
  });

  it('accepts an empty string, which means "no image"', () => {
    expect(firstError('')).toBeUndefined();
  });

  it.each([
    ['a javascript URI', 'javascript:alert(1)'],
    ['a data URI', 'data:image/svg+xml,<svg onload=alert(1)/>'],
    ['plain http', 'http://insecure.example/a.png'],
    ['a bare string', 'not-a-url'],
    ['a number', 42],
  ])('rejects %s', (_label, value) => {
    expect(firstError(value)).toBeDefined();
  });

  it('rejects a URL longer than the cap', () => {
    expect(firstError(`https://example.com/${'a'.repeat(2100)}`)).toBeDefined();
  });

  describe("without @IsOptional() (the decorator's own null/empty handling)", () => {
    it('accepts null directly, not merely via @IsOptional() short-circuiting', () => {
      expect(firstRequiredError(null)).toBeUndefined();
    });

    it('accepts an empty string directly, not merely via @IsOptional() short-circuiting', () => {
      expect(firstRequiredError('')).toBeUndefined();
    });
  });
});
