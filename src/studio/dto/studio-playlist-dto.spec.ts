import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddStudioPlaylistTracksDto } from './add-studio-playlist-tracks.dto';
import { CreateStudioPlaylistDto } from './create-studio-playlist.dto';
import { ReorderStudioPlaylistEntriesDto } from './reorder-studio-playlist-entries.dto';
import { UpdateStudioPlaylistDto } from './update-studio-playlist.dto';

const TRACK_ID = 'f1000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'f2000000-0000-4000-8000-000000000001';

const errorsFor = async <BodyClass extends object>(
  dtoClass: ClassConstructor<BodyClass>,
  body: object,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

describe('Studio playlist bodies', () => {
  it('trims a name and refuses a blank one, one of 81 characters, or a missing visibility', async () => {
    expect(
      plainToInstance(CreateStudioPlaylistDto, {
        name: '  Night bus  ',
        visibility: 'public',
      }).name,
    ).toBe('Night bus');
    expect(
      await errorsFor(CreateStudioPlaylistDto, {
        name: '   ',
        visibility: 'public',
      }),
    ).toEqual(['name']);
    expect(
      await errorsFor(CreateStudioPlaylistDto, {
        name: 'x'.repeat(81),
        visibility: 'public',
      }),
    ).toEqual(['name']);
    expect(
      await errorsFor(CreateStudioPlaylistDto, { name: 'Night bus' }),
    ).toEqual(['visibility']);
  });

  it('takes the three visibilities and refuses any other', async () => {
    for (const visibility of ['public', 'connections', 'private']) {
      expect(
        await errorsFor(CreateStudioPlaylistDto, {
          name: 'Night bus',
          visibility,
        }),
      ).toEqual([]);
    }
    expect(
      await errorsFor(CreateStudioPlaylistDto, {
        name: 'Night bus',
        visibility: 'friends',
      }),
    ).toEqual(['visibility']);
  });

  it('caps a description at 500 characters and takes a persona credit as a uuid', async () => {
    expect(
      await errorsFor(CreateStudioPlaylistDto, {
        name: 'Night bus',
        visibility: 'private',
        description: 'x'.repeat(501),
        creditSubprofileId: 'night-shift',
      }),
    ).toEqual(['creditSubprofileId', 'description']);
    expect(
      await errorsFor(CreateStudioPlaylistDto, {
        name: 'Night bus',
        visibility: 'private',
        description: 'For the N1',
        creditSubprofileId: PERSONA_ID,
      }),
    ).toEqual([]);
  });

  it('takes null on an edit to clear the description or the persona credit, and refuses null for the name and visibility', async () => {
    expect(
      await errorsFor(UpdateStudioPlaylistDto, {
        description: null,
        creditSubprofileId: null,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateStudioPlaylistDto, {
        name: null,
        visibility: null,
      }),
    ).toEqual(['name', 'visibility']);
    expect(await errorsFor(UpdateStudioPlaylistDto, {})).toEqual([]);
  });

  it('adds 1 to 50 track ids at once', async () => {
    expect(
      await errorsFor(AddStudioPlaylistTracksDto, { trackIds: [TRACK_ID] }),
    ).toEqual([]);
    expect(
      await errorsFor(AddStudioPlaylistTracksDto, { trackIds: [] }),
    ).toEqual(['trackIds']);
    expect(
      await errorsFor(AddStudioPlaylistTracksDto, {
        trackIds: Array.from({ length: 51 }, () => TRACK_ID),
      }),
    ).toEqual(['trackIds']);
    expect(
      await errorsFor(AddStudioPlaylistTracksDto, { trackIds: ['track-1'] }),
    ).toEqual(['trackIds']);
  });

  it('reorders up to 500 entry ids', async () => {
    expect(
      await errorsFor(ReorderStudioPlaylistEntriesDto, {
        entryIds: Array.from({ length: 500 }, () => TRACK_ID),
      }),
    ).toEqual([]);
    expect(
      await errorsFor(ReorderStudioPlaylistEntriesDto, {
        entryIds: Array.from({ length: 501 }, () => TRACK_ID),
      }),
    ).toEqual(['entryIds']);
  });
});
