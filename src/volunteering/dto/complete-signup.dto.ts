import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, Max, Min } from 'class-validator';

/**
 * Body for `POST /volunteering/:slug/signups/:signupId/complete`, used by the
 * opportunity's poster (or a community organiser standing in for them)
 * attesting that an accepted volunteer turned up, and for how long.
 *
 * `hours` is bounded 0..24 with two decimal places, matching the
 * `numeric(5,2)` column and its CHECK constraint. The ceiling is a day, not a
 * lifetime: this records ONE session, and the total a funder is eventually
 * shown is the sum of many attested sessions. A member cannot claim 10,000
 * hours here because the member is not the one filling this in at all, and
 * even the confirmer cannot enter a number a single day could not contain.
 *
 * `attended: false` with `hours: 0` is the recorded no-show. It is accepted
 * deliberately: writing down that the session did not happen closes the
 * signup, keeps the hours total honest, and stops the poster being asked
 * again.
 */
export class CompleteSignupDto {
  @IsBoolean() attended!: boolean;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(24)
  hours!: number;
}
