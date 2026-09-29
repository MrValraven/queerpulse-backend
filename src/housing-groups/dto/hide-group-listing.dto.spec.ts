import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HideGroupListingDto } from './hide-group-listing.dto';

/**
 * PRD-463: a takedown carries a sentence the poster can read. The reason is
 * required on a hide and ignored on an unhide.
 */
describe('HideGroupListingDto', () => {
  async function reasonErrors(body: object): Promise<number> {
    const dto = plainToInstance(HideGroupListingDto, body);
    const errors = await validate(dto);
    return errors.filter((error) => error.property === 'reason').length;
  }

  it('accepts a hide with a reason', async () => {
    expect(
      await reasonErrors({ hidden: true, reason: 'Asks for a broker fee.' }),
    ).toBe(0);
  });

  it('rejects a hide with no reason', async () => {
    expect(await reasonErrors({ hidden: true })).toBe(1);
  });

  it('rejects a hide whose reason is only whitespace', async () => {
    expect(await reasonErrors({ hidden: true, reason: '   ' })).toBe(1);
  });

  it('rejects a hide whose reason runs past 500 characters', async () => {
    expect(await reasonErrors({ hidden: true, reason: 'a'.repeat(501) })).toBe(
      1,
    );
  });

  it('trims the reason it keeps', () => {
    const dto = plainToInstance(HideGroupListingDto, {
      hidden: true,
      reason: '  Asks for a broker fee.  ',
    });
    expect(dto.reason).toBe('Asks for a broker fee.');
  });

  it('accepts an unhide with no reason', async () => {
    expect(await reasonErrors({ hidden: false })).toBe(0);
  });

  it('accepts an unhide that still sends a reason, which is ignored', async () => {
    expect(await reasonErrors({ hidden: false, reason: '' })).toBe(0);
  });
});
