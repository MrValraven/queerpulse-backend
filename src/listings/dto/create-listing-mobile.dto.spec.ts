import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { AdminUpdateListingDto } from './admin-update-listing.dto';
import { CreateListingDto } from './create-listing.dto';
import { UpdateListingDto } from './update-listing.dto';

/** Errors on one property, validating every field the way the pipe does. */
async function errorsOn(property: string, body: Record<string, unknown>) {
  const dto = plainToInstance(CreateListingDto, body);
  const errors = await validate(dto);
  return errors.filter((error) => error.property === property);
}

describe('CreateListingDto mobile fields', () => {
  it('accepts a mobile listing with full details', async () => {
    expect(
      await errorsOn('mobileDetails', {
        mobile: true,
        mobileDetails: {
          allOfCity: false,
          parishes: ['Arroios', 'Penha de França', 'Estrela'],
          alsoTravelsTo: ['Almada', 'Oeiras'],
          byAppointment: true,
        },
      }),
    ).toHaveLength(0);
  });

  it('refuses a parish outside the 24', async () => {
    expect(
      await errorsOn('mobileDetails', {
        mobile: true,
        mobileDetails: { allOfCity: false, parishes: ['Anjos'] },
      }),
    ).toHaveLength(1);
  });

  it('refuses a municipality outside the eight', async () => {
    expect(
      await errorsOn('mobileDetails', {
        mobile: true,
        mobileDetails: { alsoTravelsTo: ['Porto'] },
      }),
    ).toHaveLength(1);
  });

  it('takes a decomposed or padded spelling of a known name', async () => {
    expect(
      await errorsOn('mobileDetails', {
        mobile: true,
        mobileDetails: {
          allOfCity: false,
          parishes: ['Belém'.normalize('NFD'), ' Ajuda '],
        },
      }),
    ).toHaveLength(0);
  });

  it('refuses a by-appointment answer that is not a boolean', async () => {
    expect(
      await errorsOn('mobileDetails', {
        mobile: true,
        mobileDetails: { byAppointment: 'yes' },
      }),
    ).toHaveLength(1);
  });

  it('refuses a mobile flag that is not a boolean', async () => {
    expect(await errorsOn('mobile', { mobile: 'yes' })).toHaveLength(1);
  });

  it('asks a mobile listing for no neighbourhood, address or coordinates', async () => {
    const mobileBody = { mobile: true };
    expect(await errorsOn('hood', mobileBody)).toHaveLength(0);
    expect(await errorsOn('address', mobileBody)).toHaveLength(0);
    expect(await errorsOn('latitude', mobileBody)).toHaveLength(0);
    expect(await errorsOn('longitude', mobileBody)).toHaveLength(0);
  });

  it('takes a mobile listing with blank location fields and null coordinates', async () => {
    const mobileBody = {
      mobile: true,
      hood: '',
      address: '',
      latitude: null,
      longitude: null,
    };
    expect(await errorsOn('hood', mobileBody)).toHaveLength(0);
    expect(await errorsOn('address', mobileBody)).toHaveLength(0);
    expect(await errorsOn('latitude', mobileBody)).toHaveLength(0);
  });

  it('still checks a meeting point a mobile listing supplies', async () => {
    const mobileBody = {
      mobile: true,
      address: 'x'.repeat(301),
      latitude: 200,
      longitude: -9.13,
    };
    expect(await errorsOn('address', mobileBody)).toHaveLength(1);
    expect(await errorsOn('latitude', mobileBody)).toHaveLength(1);
  });

  it('still asks a place for its neighbourhood, address and coordinates', async () => {
    const placeBody = {};
    expect(await errorsOn('hood', placeBody)).toHaveLength(1);
    expect(await errorsOn('address', placeBody)).toHaveLength(1);
    expect(await errorsOn('latitude', placeBody)).toHaveLength(1);
    expect(await errorsOn('longitude', placeBody)).toHaveLength(1);
  });
});

describe('mobile fields through the real ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

  async function refusalOf(
    metatype: ArgumentMetadata['metatype'],
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return pipe
      .transform(body, { type: 'body', metatype })
      .catch((error: unknown) => error);
  }

  it('refuses a key the details do not define', async () => {
    expect(
      await refusalOf(UpdateListingDto, {
        mobileDetails: { radiusKm: 5 },
      }),
    ).toBeInstanceOf(BadRequestException);
  });

  it('lets a staff edit carry the mobile fields', async () => {
    await expect(
      pipe.transform(
        {
          mobile: true,
          mobileDetails: { allOfCity: true, byAppointment: true },
        },
        { type: 'body', metatype: AdminUpdateListingDto },
      ),
    ).resolves.toBeInstanceOf(AdminUpdateListingDto);
  });

  it('reads mobile: null as a key the body left out', async () => {
    const updateBody: unknown = await pipe.transform(
      { mobile: null },
      { type: 'body', metatype: UpdateListingDto },
    );
    expect((updateBody as UpdateListingDto).mobile).toBeUndefined();
  });

  it('stores the precomposed spelling the pipe normalised', async () => {
    const updateBody: unknown = await pipe.transform(
      {
        mobileDetails: {
          allOfCity: false,
          parishes: ['São Vicente'.normalize('NFD')],
        },
      },
      { type: 'body', metatype: UpdateListingDto },
    );
    expect((updateBody as UpdateListingDto).mobileDetails?.parishes).toEqual([
      'São Vicente',
    ]);
  });
});
