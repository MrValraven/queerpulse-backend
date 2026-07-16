import { IsString, MaxLength } from 'class-validator';

// Body for `PATCH /profiles/me/username` (design plan PART C / UC4). The value is
// normalized + format/reserved/uniqueness checked in the service against the ONE
// global handle namespace; here we only cap the raw length.
export class UpdateUsernameDto {
  @IsString() @MaxLength(30) username: string;
}
