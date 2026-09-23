import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AcceptListingOwnerOfferDto } from './accept-listing-owner-offer.dto';

describe('AcceptListingOwnerOfferDto', () => {
  it('accepts a payload agreeing to the affirming baseline', async () => {
    const dto = plainToInstance(AcceptListingOwnerOfferDto, {
      affirmingBaselineAccepted: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // Pins the gate with an assertion, alongside the explanatory controller
  // comment. The `respond` service call takes a plain boolean and never
  // reads this DTO, so `Equals(true)` on this field is the whole enforcement
  // of the affirming baseline. If validation ever stopped rejecting `false`,
  // an accept route bound to this DTO would let the pledge through
  // unaccepted.
  it('rejects a payload declining the affirming baseline', async () => {
    const dto = plainToInstance(AcceptListingOwnerOfferDto, {
      affirmingBaselineAccepted: false,
    });
    const errors = await validate(dto);
    expect(
      errors.some((error) => error.property === 'affirmingBaselineAccepted'),
    ).toBe(true);
  });

  it('rejects a payload missing the affirming baseline field', async () => {
    const dto = plainToInstance(AcceptListingOwnerOfferDto, {});
    const errors = await validate(dto);
    expect(
      errors.some((error) => error.property === 'affirmingBaselineAccepted'),
    ).toBe(true);
  });
});
