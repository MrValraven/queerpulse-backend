import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AddPersonaWallPickDto,
  PersonaWallSearchQuery,
  ReorderPersonaWallPicksDto,
  UpdatePersonaWallSettingsDto,
} from './persona-wall.dto';

const STRICT_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

describe('persona wall DTOs', () => {
  it('lets any subprofileId through so the service answers its code', async () => {
    for (const body of [{ subprofileId: 5 }, { subprofileId: 'nope' }, {}]) {
      const dto = plainToInstance(AddPersonaWallPickDto, body);
      expect(await validate(dto, STRICT_OPTIONS)).toHaveLength(0);
      if ('subprofileId' in body) {
        expect(dto.subprofileId).toBe(body.subprofileId);
      }
    }
  });

  it('lets any ids value through so the service answers PERSONA_WALL_REORDER_MISMATCH', async () => {
    const dto = plainToInstance(ReorderPersonaWallPicksDto, { ids: 'a' });
    expect(await validate(dto, STRICT_OPTIONS)).toHaveLength(0);
    expect(dto.ids).toBe('a');
  });

  it('lets any fillOrder through so the service answers PERSONA_WALL_INVALID_FILL_ORDER', async () => {
    for (const body of [{ fillOrder: 'shuffle' }, { fillOrder: 5 }, {}]) {
      const dto = plainToInstance(UpdatePersonaWallSettingsDto, body);
      expect(await validate(dto, STRICT_OPTIONS)).toHaveLength(0);
    }
  });

  it('lets a repeated q through', async () => {
    const dto = plainToInstance(PersonaWallSearchQuery, { q: ['a', 'b'] });
    expect(await validate(dto, STRICT_OPTIONS)).toHaveLength(0);
  });

  it('still refuses an unknown property', async () => {
    const dto = plainToInstance(UpdatePersonaWallSettingsDto, {
      fillOrder: 'newest',
      extra: 1,
    });
    expect(await validate(dto, STRICT_OPTIONS)).toHaveLength(1);
  });
});
