import { IsIn, IsString, MaxLength } from 'class-validator';

/**
 * POST /verification/identity/callback body (dev/stub shape). A real provider
 * webhook carries a signed, provider-specific payload verified in
 * `IdentityVerificationProvider.parseCallback` — this DTO only validates the
 * unsigned dev callback.
 */
export class IdentityCallbackDto {
  @IsString()
  @MaxLength(255)
  providerRef!: string;

  @IsIn(['verified', 'failed'])
  status!: 'verified' | 'failed';
}
