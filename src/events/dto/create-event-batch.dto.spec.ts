import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  CreateEventBatchDto,
  EventBatchRowDto,
  EventBatchSharedDto,
} from './create-event-batch.dto';

/**
 * The batch body through the production pipe, so the whitelist, the nested
 * transforms and `exposeUnsetFields: false` all behave as they do on the
 * route. The 31-date cap is absent here on purpose: the service checks it so
 * the refusal carries `EVENT_BATCH_TOO_MANY_DATES`.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const bodyMetadata = { type: 'body' as const, metatype: CreateEventBatchDto };

const validRow = {
  date: '2026-11-07',
  title: 'Quiz Night',
  description: 'Teams of four',
};

const validBody = {
  templateSlug: 'quiz-night',
  shared: { startTime: '21:00' },
  rows: [validRow],
};

function withShared(sharedOverrides: Record<string, unknown>) {
  return { ...validBody, shared: { ...validBody.shared, ...sharedOverrides } };
}

function withFirstRow(rowOverrides: Record<string, unknown>) {
  return { ...validBody, rows: [{ ...validRow, ...rowOverrides }] };
}

async function transformBody(body: unknown): Promise<CreateEventBatchDto> {
  return (await pipe.transform(body, bodyMetadata)) as CreateEventBatchDto;
}

describe('CreateEventBatchDto', () => {
  it('passes a minimal body and builds nested instances', async () => {
    const result = await transformBody(validBody);
    expect(result).toBeInstanceOf(CreateEventBatchDto);
    expect(result.rows[0]).toBeInstanceOf(EventBatchRowDto);
    expect(result.shared).toBeInstanceOf(EventBatchSharedDto);
  });

  it('passes 32 rows, leaving the cap to the coded service check', async () => {
    // Repeated dates are the service's to refuse too, so one row serves.
    const rows = Array.from({ length: 32 }, () => ({ ...validRow }));
    const result = await transformBody({ ...validBody, rows });
    expect(result.rows).toHaveLength(32);
  });

  it('leaves an absent shared key off the instance', async () => {
    const result = await transformBody(validBody);
    expect(Object.prototype.hasOwnProperty.call(result.shared, 'venue')).toBe(
      false,
    );
  });

  it.each([
    ['an empty rows array', { ...validBody, rows: [] }],
    [
      'a missing shared block',
      { templateSlug: 'quiz-night', rows: [validRow] },
    ],
    ['a missing shared start time', { ...validBody, shared: {} }],
    ['a start time of 24:00', withShared({ startTime: '24:00' })],
    ['a start time without a leading zero', withShared({ startTime: '9:00' })],
    ['a date that does not exist', withFirstRow({ date: '2026-02-30' })],
    ['a date without a padded day', withFirstRow({ date: '2026-11-7' })],
    ['an empty title', withFirstRow({ title: '' })],
    ['a title of 201 characters', withFirstRow({ title: 'a'.repeat(201) })],
    [
      'a description of 1201 characters',
      withFirstRow({ description: 'a'.repeat(1201) }),
    ],
    ['a venue listing id that is not a uuid', withShared({ listingId: 'abc' })],
    [
      'a payment link over http',
      withShared({ paymentUrl: 'http://pay.example.com' }),
    ],
    [
      'a row cover that is not an image key',
      withFirstRow({ coverImageUrl: 'not-a-key' }),
    ],
  ])('answers 400 for %s', async (_label, body) => {
    await expect(transformBody(body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    [
      'a run by listing on the shared block',
      withShared({ runByListingId: '5f0c1c4e-8d55-4b8a-9d55-0f3f6a8b2c11' }),
    ],
    [
      'a community on the shared block',
      withShared({ communitySlug: 'queer-runners' }),
    ],
    ['a visibility on the shared block', withShared({ visibility: 'public' })],
    ['a visibility on a row', withFirstRow({ visibility: 'public' })],
    ['a status on a row', withFirstRow({ status: 'draft' })],
  ])('answers 400 for a smuggled key: %s', async (_label, body) => {
    await expect(transformBody(body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ['a blank payment link', withShared({ paymentUrl: '' })],
    ['a cleared venue listing', withShared({ listingId: null })],
    ['a row with an open end', withFirstRow({ endTime: null })],
  ])('passes %s', async (_label, body) => {
    await expect(transformBody(body)).resolves.toBeInstanceOf(
      CreateEventBatchDto,
    );
  });
});
