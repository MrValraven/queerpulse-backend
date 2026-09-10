import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventDto } from './create-event.dto';

/**
 * The two new fields' wire contract. The family is a CLOSED vocabulary, so an
 * unknown value is a 400 rather than a silently unclassified gathering; the
 * details bag is validated for SHAPE only, since which of the six a family may
 * carry is enforced by stripping in the service (see `gathering-family.ts`).
 */
const validPayload = {
  title: 'Tuesday potluck',
  description: 'Everybody brings one thing.',
  startAt: '2026-10-01T18:00:00.000Z',
  timezone: 'Europe/Lisbon',
};

describe('CreateEventDto gathering family and format details', () => {
  it('accepts a family with a matching details bag', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      gatheringFamily: 'eat',
      eventType: 'potluck',
      formatDetails: { bring: 'a dish and a story' },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts an absent family and absent details', async () => {
    const dto = plainToInstance(CreateEventDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a family outside the nine', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      gatheringFamily: 'brunching',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'gatheringFamily')).toBe(
      true,
    );
  });

  it('rejects a runtime above the ten-hour ceiling', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      gatheringFamily: 'watch',
      formatDetails: { runtimeMinutes: 601 },
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'formatDetails')).toBe(
      true,
    );
  });

  it('rejects a runtime below one minute', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      gatheringFamily: 'watch',
      formatDetails: { runtimeMinutes: 0 },
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'formatDetails')).toBe(
      true,
    );
  });

  it('rejects a bring line over 200 characters', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      gatheringFamily: 'eat',
      formatDetails: { bring: 'x'.repeat(201) },
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'formatDetails')).toBe(
      true,
    );
  });

  it('rejects a terrain outside flat, mixed and steep', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      gatheringFamily: 'move',
      formatDetails: { terrain: 'vertical' },
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'formatDetails')).toBe(
      true,
    );
  });

  it('accepts a details bag whose keys belong to another family, so the service can strip it', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      gatheringFamily: 'watch',
      formatDetails: { bring: 'a blanket' },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
