import { IsIn } from 'class-validator';
import { SignupStatus } from '../entities/volunteer-signup.entity';

/** Body for `PATCH /volunteering/:slug/signups/:signupId` — a poster
 *  deciding on a pending applicant. Only `accepted`/`declined` are valid
 *  decisions; `pending` is a starting state, never a target one. */
export class DecideSignupDto {
  @IsIn([SignupStatus.Accepted, SignupStatus.Declined])
  status!: SignupStatus.Accepted | SignupStatus.Declined;
}
