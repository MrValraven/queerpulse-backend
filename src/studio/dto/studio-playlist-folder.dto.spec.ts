import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateStudioPlaylistFolderDto,
  MoveStudioPlaylistToFolderDto,
  UpdateStudioPlaylistFolderDto,
} from './studio-playlist-folder.dto';

const FOLDER_ID = 'f3000000-0000-4000-8000-000000000001';

const errorsFor = async <BodyClass extends object>(
  dtoClass: ClassConstructor<BodyClass>,
  body: object,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

describe('Studio playlist folder bodies', () => {
  it('trims a folder name and refuses a blank one or one of 81 characters', async () => {
    expect(
      plainToInstance(CreateStudioPlaylistFolderDto, { name: '  Road trips ' })
        .name,
    ).toBe('Road trips');
    expect(
      await errorsFor(CreateStudioPlaylistFolderDto, { name: '   ' }),
    ).toEqual(['name']);
    expect(
      await errorsFor(CreateStudioPlaylistFolderDto, { name: 'x'.repeat(81) }),
    ).toEqual(['name']);
  });

  it('leaves absent PATCH fields alone and refuses null or a negative position', async () => {
    expect(await errorsFor(UpdateStudioPlaylistFolderDto, {})).toEqual([]);
    expect(
      await errorsFor(UpdateStudioPlaylistFolderDto, {
        name: null,
        position: -1,
      }),
    ).toEqual(['name', 'position']);
    expect(
      await errorsFor(UpdateStudioPlaylistFolderDto, { position: 2 }),
    ).toEqual([]);
  });

  it('takes a folder uuid or null for a move, and refuses a missing one', async () => {
    expect(
      await errorsFor(MoveStudioPlaylistToFolderDto, { folderId: FOLDER_ID }),
    ).toEqual([]);
    expect(
      await errorsFor(MoveStudioPlaylistToFolderDto, { folderId: null }),
    ).toEqual([]);
    expect(await errorsFor(MoveStudioPlaylistToFolderDto, {})).toEqual([
      'folderId',
    ]);
    expect(
      await errorsFor(MoveStudioPlaylistToFolderDto, { folderId: 'nope' }),
    ).toEqual(['folderId']);
  });
});
