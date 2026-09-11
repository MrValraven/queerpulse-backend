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

/**
 * The care fields' wire contract (create-gathering v2). Every vocabulary is
 * closed, so an unknown key is a 400, and the theme cap counts distinct
 * themes because a duplicate is refused outright.
 */
describe('CreateEventDto care fields', () => {
  const hasErrorOn = async (
    payload: Record<string, unknown>,
    property: string,
  ): Promise<boolean> => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      ...payload,
    });
    const errors = await validate(dto);
    return errors.some((error) => error.property === property);
  };

  it('accepts every care field filled in', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      themes: ['trans-led', 'sober', 'sapphic'],
      contentNotes: ['loud-sound', 'alcohol-present'],
      houseRules: 'Ask before you touch.',
      costKind: 'pay-what-you-can',
      rsvpCutoff: 'day-before',
      rsvpQuestions: { dietary: true, pronouns: true, access: false },
      customRsvpQuestion: 'Anything you want us to know?',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts null for every nullable care field', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      houseRules: null,
      costKind: null,
      rsvpCutoff: null,
      customRsvpQuestion: null,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a partial rsvpQuestions map', async () => {
    const dto = plainToInstance(CreateEventDto, {
      ...validPayload,
      rsvpQuestions: { pronouns: true },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a fourth theme', async () => {
    expect(
      await hasErrorOn(
        { themes: ['trans-led', 'sober', 'sapphic', 'family-friendly'] },
        'themes',
      ),
    ).toBe(true);
  });

  it('rejects a theme outside the vocabulary', async () => {
    expect(await hasErrorOn({ themes: ['brunch'] }, 'themes')).toBe(true);
  });

  it('rejects the same theme twice', async () => {
    expect(await hasErrorOn({ themes: ['sober', 'sober'] }, 'themes')).toBe(
      true,
    );
  });

  it('rejects a content note outside the vocabulary', async () => {
    expect(
      await hasErrorOn({ contentNotes: ['spiders'] }, 'contentNotes'),
    ).toBe(true);
  });

  it('rejects house rules over 160 characters', async () => {
    expect(
      await hasErrorOn({ houseRules: 'x'.repeat(161) }, 'houseRules'),
    ).toBe(true);
  });

  it('rejects a cost kind outside free, pay what you can and fixed', async () => {
    expect(await hasErrorOn({ costKind: 'donation' }, 'costKind')).toBe(true);
  });

  it('accepts a cutoff at the start', async () => {
    expect(await hasErrorOn({ rsvpCutoff: 'at-start' }, 'rsvpCutoff')).toBe(
      false,
    );
  });

  it('rejects a cutoff outside the four offered', async () => {
    expect(await hasErrorOn({ rsvpCutoff: 'week-before' }, 'rsvpCutoff')).toBe(
      true,
    );
  });

  it('rejects a question flag that is not a boolean', async () => {
    expect(
      await hasErrorOn({ rsvpQuestions: { dietary: 'yes' } }, 'rsvpQuestions'),
    ).toBe(true);
  });

  it('rejects a custom question over 120 characters', async () => {
    expect(
      await hasErrorOn(
        { customRsvpQuestion: 'x'.repeat(121) },
        'customRsvpQuestion',
      ),
    ).toBe(true);
  });
});
