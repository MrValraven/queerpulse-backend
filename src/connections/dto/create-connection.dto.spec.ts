import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateConnectionDto } from './create-connection.dto';

/**
 * ENG-250 (second half): `message` and `reason` are member-authored free text
 * shown to the addressee, so they go through the same `@TrimMessageBody()`
 * control-byte strip as every other message body in the app, reusing the
 * exact decorator `ReplyToConnectionDto.body` already applies.
 *
 * Deliberately does NOT assert that markdown-triggering text like `x<y` is
 * altered, because `sanitizeMessageBody` stops short of `toStoredPlainText` on
 * purpose (see `trim-message-body.ts`); this suite proves that boundary holds
 * here too.
 */
describe('CreateConnectionDto', () => {
  const validBody = {
    toSlug: 'some-member',
  };

  const propertiesWithErrors = async (
    payload: Record<string, unknown>,
  ): Promise<string[]> => {
    const errors = await validate(
      plainToInstance(CreateConnectionDto, payload),
    );
    return errors.map((error) => error.property);
  };

  const transform = (payload: Record<string, unknown>): CreateConnectionDto =>
    plainToInstance(CreateConnectionDto, payload);

  it('accepts the minimal shape with no note or reason', async () => {
    expect(await propertiesWithErrors(validBody)).toEqual([]);
  });

  it('strips control bytes from the note on the way in', () => {
    const withControlBytes = `Hey\x00, would\x07 love to\x1fconnect`;
    const instance = transform({ ...validBody, message: withControlBytes });
    expect(instance.message).toBe('Hey, would love toconnect');
  });

  it('strips control bytes from a custom reason on the way in', () => {
    const withControlBytes = `custom:We met\x00 at Pride`;
    const instance = transform({ ...validBody, reason: withControlBytes });
    expect(instance.reason).toBe('custom:We met at Pride');
  });

  it('normalizes CRLF and lone CR to \\n in the note, matching sanitizeMessageBody', () => {
    const instance = transform({
      ...validBody,
      message: 'Line one\r\nLine two\rLine three',
    });
    expect(instance.message).toBe('Line one\nLine two\nLine three');
  });

  it('leaves ordinary chat text such as x<y untouched, unlike toStoredPlainText', async () => {
    const ordinaryText =
      'if x<y and y>z, DM me <https://example.com/party> or `tag` me';
    const instance = transform({ ...validBody, message: ordinaryText });
    expect(instance.message).toBe(ordinaryText);
    expect(
      await propertiesWithErrors({ ...validBody, message: ordinaryText }),
    ).toEqual([]);
  });

  it('trims a whitespace-only note to empty, the same collapse the messaging DTOs apply', () => {
    const instance = transform({ ...validBody, message: '   \n\t  ' });
    expect(instance.message).toBe('');
  });

  it('accepts a whitespace-only note, since this field is optional with no MinLength unlike SendMessageDto.body', async () => {
    expect(
      await propertiesWithErrors({ ...validBody, message: '   \n\t  ' }),
    ).toEqual([]);
  });

  it('accepts a whitespace-only reason for the same reason', async () => {
    expect(await propertiesWithErrors({ ...validBody, reason: '   ' })).toEqual(
      [],
    );
  });

  it('validates the trimmed length of the note: padding trimmed under the cap passes', async () => {
    const paddedButShort = `  ${'a'.repeat(1990)}  `; // raw length 1994, trimmed length 1990
    expect(paddedButShort.length).toBeGreaterThan(2000 - 10);
    expect(
      await propertiesWithErrors({ ...validBody, message: paddedButShort }),
    ).toEqual([]);
  });

  it('validates the trimmed length of the note: content over the cap still fails after trimming', async () => {
    const overCapAfterTrim = `  ${'a'.repeat(2001)}  `;
    expect(
      await propertiesWithErrors({ ...validBody, message: overCapAfterTrim }),
    ).toContain('message');
  });

  it('does not alter identifier fields (toSlug, introducerSlug), which are not member-authored prose', () => {
    const instance = transform({
      toSlug: 'some-member',
      introducerSlug: 'another-member',
    });
    expect(instance.toSlug).toBe('some-member');
    expect(instance.introducerSlug).toBe('another-member');
  });
});
