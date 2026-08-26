import { IsBoolean } from 'class-validator';

// `PUT /me/public-profile` — the single publication switch.
//
// ⚠️ `true` PUBLISHES TO THE OPEN WEB. It is the gate on the unauthenticated
// `GET /public/profiles/:slug`. The server evaluates eligibility before
// honouring it (`PublicEligibilityService.assertMayGoPublic`) and 403s an
// ineligible member; `false` is always accepted. See
// `PreferencesService.updatePublicProfile`.
export class UpdatePublicProfileDto {
  @IsBoolean()
  enabled!: boolean;
}
