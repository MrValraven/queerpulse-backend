import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateStudioPressKitDto } from './update-studio-press-kit.dto';

const TRACK_ID = 'da000000-0000-4000-8000-000000000001';

const validBody = {
  pitch: 'Lisbon club music',
  pressBio: 'A press bio.',
  featuredTrackIds: [TRACK_ID],
  quotes: [{ quote: 'Hypnotic', source: 'Rádio Quântica' }],
  contact: 'mailto:booking@nightshift.test',
};

const errorsFor = async (body: object): Promise<string[]> =>
  (await validate(plainToInstance(UpdateStudioPressKitDto, body)))
    .map((error) => error.property)
    .sort();

describe('UpdateStudioPressKitDto', () => {
  it('accepts a full body and an emptied one', async () => {
    expect(await errorsFor(validBody)).toEqual([]);
    expect(
      await errorsFor({
        pitch: null,
        pressBio: null,
        featuredTrackIds: [],
        quotes: [],
        contact: null,
      }),
    ).toEqual([]);
  });

  it('needs every key', async () => {
    expect(await errorsFor({})).toEqual([
      'contact',
      'featuredTrackIds',
      'pitch',
      'pressBio',
      'quotes',
    ]);
  });

  it('trims text and holds the lengths', async () => {
    const trimmed = plainToInstance(UpdateStudioPressKitDto, {
      ...validBody,
      pitch: '  Lisbon club music  ',
    });
    expect(trimmed.pitch).toBe('Lisbon club music');
    expect(
      await errorsFor({
        ...validBody,
        pitch: 'x'.repeat(141),
        pressBio: 'x'.repeat(1501),
        contact: `https://x.test/${'y'.repeat(1000)}`,
      }),
    ).toEqual(['contact', 'pitch', 'pressBio']);
  });

  it('trims the press bio and contact and keeps an emptied contact valid', async () => {
    const trimmed = plainToInstance(UpdateStudioPressKitDto, {
      ...validBody,
      pressBio: '  A press bio.  ',
      contact: ' https://x.test',
    });
    expect(trimmed.pressBio).toBe('A press bio.');
    expect(trimmed.contact).toBe('https://x.test');
    expect(await validate(trimmed)).toEqual([]);
    const emptied = plainToInstance(UpdateStudioPressKitDto, {
      ...validBody,
      pressBio: '   ',
      contact: '   ',
    });
    expect(emptied.pressBio).toBe('');
    expect(emptied.contact).toBe('');
    expect(await validate(emptied)).toEqual([]);
  });

  it('refuses six picks, a repeated pick and a pick that is not a uuid', async () => {
    const sixIds = Array.from(
      { length: 6 },
      (_unused, index) => `da000000-0000-4000-8000-00000000001${index}`,
    );
    expect(await errorsFor({ ...validBody, featuredTrackIds: sixIds })).toEqual(
      ['featuredTrackIds'],
    );
    expect(
      await errorsFor({
        ...validBody,
        featuredTrackIds: [TRACK_ID, TRACK_ID.toUpperCase()],
      }),
    ).toEqual(['featuredTrackIds']);
    expect(
      await errorsFor({ ...validBody, featuredTrackIds: ['track-1'] }),
    ).toEqual(['featuredTrackIds']);
  });

  it('refuses four quotes, a blank quote and an overlong source', async () => {
    const quote = { quote: 'Hypnotic', source: 'Rádio Quântica' };
    expect(
      await errorsFor({ ...validBody, quotes: [quote, quote, quote, quote] }),
    ).toEqual(['quotes']);
    expect(
      await errorsFor({ ...validBody, quotes: [{ quote: '  ', source: 'A' }] }),
    ).toEqual(['quotes']);
    expect(
      await errorsFor({
        ...validBody,
        quotes: [{ quote: 'Yes', source: 'x'.repeat(81) }],
      }),
    ).toEqual(['quotes']);
  });

  it('takes an https or mailto contact and refuses anything else', async () => {
    expect(
      await errorsFor({ ...validBody, contact: 'https://nightshift.test' }),
    ).toEqual([]);
    for (const contact of ['javascript:alert(1)', 'http://x.test', 'x.test']) {
      expect(await errorsFor({ ...validBody, contact })).toEqual(['contact']);
    }
  });
});
