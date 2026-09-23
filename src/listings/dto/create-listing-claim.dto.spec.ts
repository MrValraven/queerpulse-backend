import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateListingClaimDto } from './create-listing-claim.dto';

describe('CreateListingClaimDto', () => {
  it('accepts a payload agreeing to the affirming baseline', async () => {
    const dto = plainToInstance(CreateListingClaimDto, {
      note: "I'm the owner, here's how to verify me.",
      affirmingBaselineAccepted: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a payload with no note at all, note being optional', async () => {
    const dto = plainToInstance(CreateListingClaimDto, {
      affirmingBaselineAccepted: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // Pins the gate with an assertion, alongside the explanatory doc comment on
  // the field. `requestClaim` takes a plain `note` string and never reads
  // this DTO for the pledge, so `Equals(true)` on this field is the whole
  // enforcement of the affirming baseline for every claim. If validation ever
  // stopped rejecting `false`, a member could become the owner of an
  // admin-authored listing without ever agreeing to it.
  it('rejects a payload declining the affirming baseline', async () => {
    const dto = plainToInstance(CreateListingClaimDto, {
      affirmingBaselineAccepted: false,
    });
    const errors = await validate(dto);
    expect(
      errors.some((error) => error.property === 'affirmingBaselineAccepted'),
    ).toBe(true);
  });

  it('rejects a payload missing the affirming baseline field', async () => {
    const dto = plainToInstance(CreateListingClaimDto, {
      note: 'I run this place.',
    });
    const errors = await validate(dto);
    expect(
      errors.some((error) => error.property === 'affirmingBaselineAccepted'),
    ).toBe(true);
  });
});
