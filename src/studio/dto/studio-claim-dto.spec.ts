import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CounterStudioClaimDto } from './counter-studio-claim.dto';
import { CreateStudioClaimDto } from './create-studio-claim.dto';
import { ReplyStudioClaimDto } from './reply-studio-claim.dto';

async function errorsFor(
  dtoClass: new () => object,
  body: object,
): Promise<string[]> {
  return (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();
}

const validClaim = {
  claimantRole: 'rights_holder',
  originalWork: '  Saudade by Ana Moura ',
  originalLink: ' https://example.test/saudade ',
  details: ' The hook from 0:40 is lifted whole ',
  goodFaith: true,
};

describe('Studio claim bodies', () => {
  it('takes a full claim and trims its text', async () => {
    expect(await errorsFor(CreateStudioClaimDto, validClaim)).toEqual([]);
    const body = plainToInstance(CreateStudioClaimDto, validClaim);
    expect(body.originalWork).toBe('Saudade by Ana Moura');
    expect(body.originalLink).toBe('https://example.test/saudade');
    expect(body.details).toBe('The hook from 0:40 is lifted whole');
  });

  it('stores an empty or null link as null and an absent one as absent', async () => {
    for (const originalLink of ['', '   ', null]) {
      const body = plainToInstance(CreateStudioClaimDto, {
        ...validClaim,
        originalLink,
      });
      expect(body.originalLink).toBeNull();
      expect(
        await errorsFor(CreateStudioClaimDto, { ...validClaim, originalLink }),
      ).toEqual([]);
    }
    const withoutLink: Record<string, unknown> = { ...validClaim };
    delete withoutLink.originalLink;
    expect(await errorsFor(CreateStudioClaimDto, withoutLink)).toEqual([]);
  });

  it('refuses a link that is not a safe web link, or too long', async () => {
    for (const originalLink of [
      'javascript:alert(1)',
      'ftp://example.test/a',
      'example.test/a',
      `https://example.test/${'a'.repeat(490)}`,
    ]) {
      expect(
        await errorsFor(CreateStudioClaimDto, { ...validClaim, originalLink }),
      ).toEqual(['originalLink']);
    }
  });

  it('refuses an unknown role, blank fields, long fields and a missing good-faith tick', async () => {
    expect(
      await errorsFor(CreateStudioClaimDto, {
        ...validClaim,
        claimantRole: 'fan',
        originalWork: '  ',
        details: 'x'.repeat(2001),
        goodFaith: false,
      }),
    ).toEqual(['claimantRole', 'details', 'goodFaith', 'originalWork']);
    expect(
      await errorsFor(CreateStudioClaimDto, {
        ...validClaim,
        originalWork: 'x'.repeat(201),
      }),
    ).toEqual(['originalWork']);
  });

  it('holds a reply to 1 to 1000 characters after trimming', async () => {
    expect(await errorsFor(ReplyStudioClaimDto, { reply: ' No ' })).toEqual([]);
    expect(plainToInstance(ReplyStudioClaimDto, { reply: ' No ' }).reply).toBe(
      'No',
    );
    expect(await errorsFor(ReplyStudioClaimDto, { reply: '  ' })).toEqual([
      'reply',
    ]);
    expect(
      await errorsFor(ReplyStudioClaimDto, { reply: 'x'.repeat(1001) }),
    ).toEqual(['reply']);
  });

  it('holds a counter-notice to 1 to 2000 characters with the good-faith tick', async () => {
    expect(
      await errorsFor(CounterStudioClaimDto, {
        note: 'I wrote every bar',
        goodFaith: true,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(CounterStudioClaimDto, {
        note: 'x'.repeat(2001),
        goodFaith: 'true',
      }),
    ).toEqual(['goodFaith', 'note']);
  });
});
