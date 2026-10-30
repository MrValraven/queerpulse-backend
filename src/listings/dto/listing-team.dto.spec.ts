import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ApproveListingTeamRequestDto,
  InviteListingTeamMemberByProfileDto,
  InviteListingTeamMemberDto,
  ListingTeamPersonaSearchQuery,
  ReorderListingTeamDto,
  UpdateListingTeamMemberDto,
} from './listing-team.dto';

const FIRST_UUID = '3f0f6a52-5a52-4c0a-9d3e-0a6c1d2b7e11';
const SECOND_UUID = '9b1d4c7e-2f35-4b8a-8c61-5e7d0a9f3c22';

describe('listing team DTOs', () => {
  it('trims a role label and stores an empty one as null', async () => {
    const trimmed = plainToInstance(InviteListingTeamMemberDto, {
      subprofileId: FIRST_UUID,
      roleLabel: '  Resident artist  ',
    });
    expect(await validate(trimmed)).toHaveLength(0);
    expect(trimmed.roleLabel).toBe('Resident artist');

    const blank = plainToInstance(InviteListingTeamMemberDto, {
      subprofileId: FIRST_UUID,
      roleLabel: '   ',
    });
    expect(await validate(blank)).toHaveLength(0);
    expect(blank.roleLabel).toBeNull();
  });

  it('refuses a role label over 40 characters after trimming', async () => {
    const tooLong = plainToInstance(InviteListingTeamMemberDto, {
      subprofileId: FIRST_UUID,
      roleLabel: 'a'.repeat(41),
    });
    const errors = await validate(tooLong);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('roleLabel');

    const paddedButShort = plainToInstance(InviteListingTeamMemberDto, {
      subprofileId: FIRST_UUID,
      roleLabel: ` ${'a'.repeat(40)} `,
    });
    expect(await validate(paddedButShort)).toHaveLength(0);
  });

  it('refuses a role label with a line break', async () => {
    const dto = plainToInstance(InviteListingTeamMemberDto, {
      subprofileId: FIRST_UUID,
      roleLabel: 'Guest\nartist',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'roleLabel')).toBe(true);
  });

  it('refuses a role label with a Unicode line separator', async () => {
    const dto = plainToInstance(InviteListingTeamMemberDto, {
      subprofileId: FIRST_UUID,
      roleLabel: 'Guest\u2028artist',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'roleLabel')).toBe(true);
  });

  it('invites a member by slug with the same role label rules', async () => {
    const trimmed = plainToInstance(InviteListingTeamMemberByProfileDto, {
      memberSlug: 'ana-silva',
      roleLabel: '  Host  ',
    });
    expect(await validate(trimmed)).toHaveLength(0);
    expect(trimmed.roleLabel).toBe('Host');

    const blank = plainToInstance(InviteListingTeamMemberByProfileDto, {
      memberSlug: 'ana-silva',
      roleLabel: '  ',
    });
    expect(await validate(blank)).toHaveLength(0);
    expect(blank.roleLabel).toBeNull();

    const absent = plainToInstance(InviteListingTeamMemberByProfileDto, {
      memberSlug: 'ana-silva',
    });
    expect(await validate(absent)).toHaveLength(0);
    expect(absent.roleLabel).toBeUndefined();

    const lineBreak = plainToInstance(InviteListingTeamMemberByProfileDto, {
      memberSlug: 'ana-silva',
      roleLabel: 'Guest\nartist',
    });
    expect(
      (await validate(lineBreak)).some(
        (error) => error.property === 'roleLabel',
      ),
    ).toBe(true);
  });

  it('bounds the member slug to 1 to 64 characters', async () => {
    for (const memberSlug of ['', 'a'.repeat(65), 42, undefined]) {
      const dto = plainToInstance(InviteListingTeamMemberByProfileDto, {
        memberSlug,
      });
      const errors = await validate(dto);
      expect(errors.some((error) => error.property === 'memberSlug')).toBe(
        true,
      );
    }
    const edge = plainToInstance(InviteListingTeamMemberByProfileDto, {
      memberSlug: 'a'.repeat(64),
    });
    expect(await validate(edge)).toHaveLength(0);
  });

  it('keeps an absent role label absent on approve', async () => {
    const dto = plainToInstance(ApproveListingTeamRequestDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(Object.keys(dto)).not.toContain('roleLabel');
  });

  it('requires the role label key on PATCH and accepts null', async () => {
    const missing = plainToInstance(UpdateListingTeamMemberDto, {});
    const missingErrors = await validate(missing);
    expect(missingErrors.some((error) => error.property === 'roleLabel')).toBe(
      true,
    );

    const cleared = plainToInstance(UpdateListingTeamMemberDto, {
      roleLabel: null,
    });
    expect(await validate(cleared)).toHaveLength(0);
  });

  it('drops a leading at sign from the persona search and bounds the length', async () => {
    const accepted = plainToInstance(ListingTeamPersonaSearchQuery, {
      q: '  @riv ',
    });
    expect(await validate(accepted)).toHaveLength(0);
    expect(accepted.q).toBe('riv');

    const tooShort = plainToInstance(ListingTeamPersonaSearchQuery, { q: 'r' });
    expect(await validate(tooShort)).not.toHaveLength(0);

    const tooLong = plainToInstance(ListingTeamPersonaSearchQuery, {
      q: 'a'.repeat(61),
    });
    expect(await validate(tooLong)).not.toHaveLength(0);
  });

  it('refuses duplicate member ids and a malformed id in the order', async () => {
    const duplicated = plainToInstance(ReorderListingTeamDto, {
      memberIds: [FIRST_UUID, FIRST_UUID],
    });
    expect(await validate(duplicated)).not.toHaveLength(0);

    const malformed = plainToInstance(ReorderListingTeamDto, {
      memberIds: ['x'],
    });
    expect(await validate(malformed)).not.toHaveLength(0);

    const empty = plainToInstance(ReorderListingTeamDto, { memberIds: [] });
    expect(await validate(empty)).toHaveLength(0);

    const distinct = plainToInstance(ReorderListingTeamDto, {
      memberIds: [FIRST_UUID, SECOND_UUID],
    });
    expect(await validate(distinct)).toHaveLength(0);
  });
});
