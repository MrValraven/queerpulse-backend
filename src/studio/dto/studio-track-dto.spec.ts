import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfirmStudioAudioDto } from './confirm-studio-audio.dto';
import { CreateStudioTrackDto } from './create-studio-track.dto';
import { ReorderStudioTracksDto } from './reorder-studio-tracks.dto';
import { UpdateStudioTrackDto } from './update-studio-track.dto';

const TRACK_ID = 'e1000000-0000-4000-8000-000000000001';

async function errorsFor(
  dtoClass: new () => object,
  body: object,
): Promise<string[]> {
  return (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();
}

describe('Studio track bodies', () => {
  it('trims a track title and refuses a blank one', async () => {
    expect(
      plainToInstance(CreateStudioTrackDto, { title: '  Opening ' }).title,
    ).toBe('Opening');
    expect(await errorsFor(CreateStudioTrackDto, { title: '  ' })).toEqual([
      'title',
    ]);
  });

  it('trims credit names and roles and allows twenty rows', async () => {
    const body = plainToInstance(UpdateStudioTrackDto, {
      credits: [{ name: ' Ana ', role: ' Vocals ' }],
    });
    expect(body.credits).toEqual([{ name: 'Ana', role: 'Vocals' }]);
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        credits: Array.from({ length: 20 }, () => ({
          name: 'Ana',
          role: 'Vocals',
        })),
      }),
    ).toEqual([]);
  });

  it('refuses a 21st credit, a blank role and an 81-character name', async () => {
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        credits: Array.from({ length: 21 }, () => ({
          name: 'Ana',
          role: 'Vocals',
        })),
      }),
    ).toEqual(['credits']);
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        credits: [{ name: 'Ana', role: ' ' }],
      }),
    ).toEqual(['credits']);
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        credits: [{ name: 'x'.repeat(81), role: 'Vocals' }],
      }),
    ).toEqual(['credits']);
  });

  it('refuses null for the title, credits and explicit flag, and takes null lyrics', async () => {
    expect(
      await errorsFor(UpdateStudioTrackDto, {
        title: null,
        credits: null,
        isExplicit: null,
      }),
    ).toEqual(['credits', 'isExplicit', 'title']);
    expect(await errorsFor(UpdateStudioTrackDto, { lyrics: null })).toEqual([]);
    expect(
      await errorsFor(UpdateStudioTrackDto, { lyrics: 'x'.repeat(10001) }),
    ).toEqual(['lyrics']);
  });

  it('takes between one and fifty track ids for an order', async () => {
    expect(await errorsFor(ReorderStudioTracksDto, { trackIds: [] })).toEqual([
      'trackIds',
    ]);
    expect(
      await errorsFor(ReorderStudioTracksDto, {
        trackIds: [TRACK_ID, 'track-2'],
      }),
    ).toEqual(['trackIds']);
    expect(
      await errorsFor(ReorderStudioTracksDto, { trackIds: [TRACK_ID] }),
    ).toEqual([]);
  });

  it('takes a minted Studio audio key only', async () => {
    expect(
      await errorsFor(ConfirmStudioAudioDto, {
        key: 'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.m4a',
      }),
    ).toEqual([]);
    expect(
      await errorsFor(ConfirmStudioAudioDto, {
        key: 'avatars/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.jpg',
      }),
    ).toEqual(['key']);
  });
});
