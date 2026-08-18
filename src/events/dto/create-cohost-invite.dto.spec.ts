import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCohostInviteDto } from './create-cohost-invite.dto';

describe('CreateCohostInviteDto', () => {
  it('accepts a valid payload', async () => {
    const dto = plainToInstance(CreateCohostInviteDto, {
      inviteeSlug: 'sofia',
      role: 'greeter',
      commitment: 'light',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a role outside the fixed taxonomy', async () => {
    const dto = plainToInstance(CreateCohostInviteDto, {
      inviteeSlug: 'sofia',
      role: 'not-a-real-role',
      commitment: 'light',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it('rejects a commitment outside the fixed taxonomy', async () => {
    const dto = plainToInstance(CreateCohostInviteDto, {
      inviteeSlug: 'sofia',
      role: 'greeter',
      commitment: 'not-a-real-commitment',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'commitment')).toBe(true);
  });

  it('rejects a message over 500 characters', async () => {
    const dto = plainToInstance(CreateCohostInviteDto, {
      inviteeSlug: 'sofia',
      role: 'greeter',
      commitment: 'light',
      message: 'x'.repeat(501),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'message')).toBe(true);
  });
});
