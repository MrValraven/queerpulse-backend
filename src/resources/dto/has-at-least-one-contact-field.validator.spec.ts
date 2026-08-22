import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateResourceListingDto } from './create-resource-listing.dto';
import { hasAtLeastOneContactField } from './has-at-least-one-contact-field.validator';
import { ResourceListingCategory } from '../entities/resource-listing.entity';

describe('hasAtLeastOneContactField', () => {
  it('is true when at least one contact field is a non-blank string', () => {
    expect(hasAtLeastOneContactField({ phone: '+351 912 345 678' })).toBe(true);
    expect(hasAtLeastOneContactField({ email: 'help@example.org' })).toBe(true);
    expect(hasAtLeastOneContactField({ website: 'example.org' })).toBe(true);
  });

  it('is false when every contact field is missing or blank', () => {
    expect(hasAtLeastOneContactField({})).toBe(false);
    expect(hasAtLeastOneContactField({ phone: '   ' })).toBe(false);
    expect(
      hasAtLeastOneContactField({ phone: null, email: null, website: null }),
    ).toBe(false);
  });
});

describe('CreateResourceListingDto contact-field validation', () => {
  const base = {
    category: ResourceListingCategory.LegalAid,
    title: 'Coimbra Legal Aid Clinic',
    description: 'Free consultations for LGBTQ+ workplace discrimination.',
  };

  it('rejects a listing with no phone, email, or website', async () => {
    const dto = plainToInstance(CreateResourceListingDto, { ...base });
    const errors = await validate(dto);
    expect(
      errors.some((e) =>
        Object.keys(e.constraints ?? {}).includes('hasAtLeastOneContactField'),
      ),
    ).toBe(true);
  });

  it('accepts a listing that only sets email (phone/website omitted)', async () => {
    const dto = plainToInstance(CreateResourceListingDto, {
      ...base,
      email: 'intake@coimbralegal.org',
    });
    const errors = await validate(dto);
    expect(
      errors.some((e) =>
        Object.keys(e.constraints ?? {}).includes('hasAtLeastOneContactField'),
      ),
    ).toBe(false);
  });
});
