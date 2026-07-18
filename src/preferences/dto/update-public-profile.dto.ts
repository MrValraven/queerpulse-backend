import { IsBoolean } from 'class-validator';

// `PUT /me/public-profile` — the single publication switch.
//
// NOTE: setting this to `true` does not currently expose anything to anyone.
// See the doc comment on `MemberPreferences.publicProfileEnabled`.
export class UpdatePublicProfileDto {
  @IsBoolean()
  enabled: boolean;
}
