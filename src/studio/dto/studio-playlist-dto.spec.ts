import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddStudioPlaylistEditorsDto } from './add-studio-playlist-editors.dto';
import { AddStudioPlaylistTracksDto } from './add-studio-playlist-tracks.dto';
import { CreateStudioPlaylistDto } from './create-studio-playlist.dto';
import { ListStudioPlaylistEditorCandidatesQuery } from './list-studio-playlist-editor-candidates.query';
import { ReorderStudioPlaylistEntriesDto } from './reorder-studio-playlist-entries.dto';
import { RespondStudioPlaylistEditorInviteDto } from './respond-studio-playlist-editor-invite.dto';
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

describe('Studio playlist editor bodies', () => {
  it('takes one to ten unique member slugs', async () => {
    expect(
      await errorsFor(AddStudioPlaylistEditorsDto, {
        memberSlugs: ['ana-silva', 'bea-costa'],
      }),
    ).toEqual([]);
    expect(
      await errorsFor(AddStudioPlaylistEditorsDto, { memberSlugs: [] }),
    ).toEqual(['memberSlugs']);
    expect(
      await errorsFor(AddStudioPlaylistEditorsDto, {
        memberSlugs: Array.from(
          { length: 11 },
          (_unused, index) => `m-${index}`,
        ),
      }),
    ).toEqual(['memberSlugs']);
    expect(
      await errorsFor(AddStudioPlaylistEditorsDto, {
        memberSlugs: ['ana-silva', 'ana-silva'],
      }),
    ).toEqual(['memberSlugs']);
  });

  it('refuses a blank slug, one of 121 characters, and anything but strings', async () => {
    for (const memberSlugs of [[''], ['x'.repeat(121)], [42], 'ana-silva']) {
      expect(
        await errorsFor(AddStudioPlaylistEditorsDto, { memberSlugs }),
      ).toEqual(['memberSlugs']);
    }
  });

  it('takes accept or decline and nothing else', async () => {
    for (const response of ['accept', 'decline']) {
      expect(
        await errorsFor(RespondStudioPlaylistEditorInviteDto, { response }),
      ).toEqual([]);
    }
    expect(
      await errorsFor(RespondStudioPlaylistEditorInviteDto, {
        response: 'maybe',
      }),
    ).toEqual(['response']);
    expect(await errorsFor(RespondStudioPlaylistEditorInviteDto, {})).toEqual([
      'response',
    ]);
  });

  it('trims the candidate search and bounds it at 80 characters', async () => {
    expect(
      plainToInstance(ListStudioPlaylistEditorCandidatesQuery, {
        q: '  Ana  ',
      }).q,
    ).toBe('Ana');
    expect(
      await errorsFor(ListStudioPlaylistEditorCandidatesQuery, {}),
    ).toEqual([]);
    expect(
      await errorsFor(ListStudioPlaylistEditorCandidatesQuery, {
        q: 'x'.repeat(81),
      }),
    ).toEqual(['q']);
  });

  it('takes the editor removal confirmation as a boolean on a playlist edit', async () => {
    expect(
      await errorsFor(UpdateStudioPlaylistDto, {
        creditSubprofileId: PERSONA_ID,
        confirmEditorRemoval: true,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(UpdateStudioPlaylistDto, { confirmEditorRemoval: 'yes' }),
    ).toEqual(['confirmEditorRemoval']);
  });
});
