import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateRsvpDetailsDto } from './update-rsvp-details.dto';

/**
 * The attendee's answers to a gathering's optional questions. Length-capped
 * only: a blank answer is how a member clears one, so it must reach the
 * service, which stores it as null.
 */
describe('UpdateRsvpDetailsDto question answers', () => {
  it('accepts pronouns and a custom answer', async () => {
    const dto = plainToInstance(UpdateRsvpDetailsDto, {
      pronouns: 'they/them',
      customAnswer: 'I will arrive a little late.',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts blank answers, which clear the stored ones', async () => {
    const dto = plainToInstance(UpdateRsvpDetailsDto, {
      pronouns: '',
      customAnswer: '',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects pronouns over 60 characters', async () => {
    const dto = plainToInstance(UpdateRsvpDetailsDto, {
      pronouns: 'x'.repeat(61),
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'pronouns')).toBe(true);
  });

  it('rejects a custom answer over 500 characters', async () => {
    const dto = plainToInstance(UpdateRsvpDetailsDto, {
      customAnswer: 'x'.repeat(501),
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'customAnswer')).toBe(
      true,
    );
  });
});
