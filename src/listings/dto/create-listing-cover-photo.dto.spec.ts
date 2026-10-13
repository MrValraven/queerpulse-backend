import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { CreateListingDto } from './create-listing.dto';
import { UpdateListingDto } from './update-listing.dto';

async function errorsOn(property: string, body: Record<string, unknown>) {
  const dto = plainToInstance(CreateListingDto, body);
  const errors = await validate(dto, { skipMissingProperties: true });
  return errors.filter((error) => error.property === property);
}

describe('CreateListingDto.coverPhoto', () => {
  it('accepts a storage key with alt text', async () => {
    const errors = await errorsOn('coverPhoto', {
      coverPhoto: {
        image:
          'listing-covers/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.webp',
        alt: 'The bar from the street',
      },
    });
    expect(errors).toEqual([]);
  });

  it('refuses an image that is not an image reference', async () => {
    const errors = await errorsOn('coverPhoto', {
      coverPhoto: { image: 'javascript:alert(1)', alt: '' },
    });
    expect(errors[0]?.children?.[0]?.property).toBe('image');
  });

  it('refuses alt text over 100 characters', async () => {
    const errors = await errorsOn('coverPhoto', {
      coverPhoto: { image: '', alt: 'x'.repeat(101) },
    });
    expect(errors[0]?.children?.[0]?.property).toBe('alt');
  });
});

describe('coverPhoto through the real ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

  it('accepts null on the update body, which clears the cover', async () => {
    const updateBody: unknown = await pipe.transform(
      { coverPhoto: null },
      { type: 'body', metatype: UpdateListingDto },
    );

    expect(updateBody).toBeInstanceOf(UpdateListingDto);
    expect((updateBody as UpdateListingDto).coverPhoto).toBeNull();
  });

  it('refuses a cover that leaves out alt, which is required on the wire', async () => {
    await expect(
      pipe.transform(
        { coverPhoto: { image: '' } },
        { type: 'body', metatype: UpdateListingDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
