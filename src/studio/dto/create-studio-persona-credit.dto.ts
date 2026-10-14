import { IsIn, IsString, MaxLength } from 'class-validator';
import { STUDIO_CREDIT_ROLES, StudioCreditRole } from '../studio.constants';

export class CreateStudioPersonaCreditDto {
  /** An exact handle, with or without one leading `@`. The service
   *  normalizes it and answers 422 when no creditable persona holds it; the
   *  bound here only caps the request size. */
  @IsString()
  @MaxLength(200)
  handle!: string;

  @IsIn(STUDIO_CREDIT_ROLES)
  role!: StudioCreditRole;
}
