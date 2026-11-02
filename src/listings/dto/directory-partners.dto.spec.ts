import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateDirectoryPartnerDto,
  DirectoryPartnerSearchQuery,
  ReorderDirectoryPartnersDto,
  UpdateDirectoryPartnerNoteDto,
} from './directory-partners.dto';

describe('directory partner DTOs', () => {
  it('lets a 141-character note through so the service answers note_too_long', async () => {
    const dto = plainToInstance(CreateDirectoryPartnerDto, {
      listingId: '22222222-2222-4222-8222-222222222222',
      note: 'a'.repeat(141),
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('lets a non-uuid listingId string through so the service answers listing_not_found', async () => {
    const dto = plainToInstance(CreateDirectoryPartnerDto, {
      listingId: 'not-a-uuid',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('refuses a create body without listingId', async () => {
    const dto = plainToInstance(CreateDirectoryPartnerDto, {});
    expect(await validate(dto)).toHaveLength(1);
  });

  it('requires note on the note update and accepts null', async () => {
    const missingNote = plainToInstance(UpdateDirectoryPartnerNoteDto, {});
    expect((await validate(missingNote)).length).toBeGreaterThan(0);
    const clearedNote = plainToInstance(UpdateDirectoryPartnerNoteDto, {
      note: null,
    });
    expect(await validate(clearedNote)).toHaveLength(0);
  });

  it('requires ids to be an array of strings', async () => {
    const notAnArray = plainToInstance(ReorderDirectoryPartnersDto, {
      ids: 'a',
    });
    expect((await validate(notAnArray)).length).toBeGreaterThan(0);
    const anArray = plainToInstance(ReorderDirectoryPartnersDto, {
      ids: ['a'],
    });
    expect(await validate(anArray)).toHaveLength(0);
  });

  it('accepts a search query with no q', async () => {
    const dto = plainToInstance(DirectoryPartnerSearchQuery, {});
    expect(await validate(dto)).toHaveLength(0);
  });
});
